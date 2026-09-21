'use client';

/**
 * Orchestrating the parse workers: handing out files, and routing what comes
 * back to the record store and to the progress reporters.
 *
 * This is the only module that knows the worker protocol. Its shape is
 * documented on the other side, in backend/parser/worker.entry.ts.
 */

import { WarcFileHande, WarcParseFailure, WarcRecordEntries, WarcWorkerHandle } from "./types";
import { parserBundleBuiltAt, parserScriptProblem, parserScriptUrl } from "./parserBundle";
import { applyProgress, failHandle, toParseFailure } from "./progress";
import { pushRecord } from "./records";
import { toWarcRecord } from "./wire";

/**
 * Message actions this module handles. Anything else is reported once — see the
 * default branch in the worker's onmessage.
 */
const KNOWN_ACTIONS = new Set(['progress', 'newRecords', 'parsed', 'error', 'resegmented']);

/** Actions already complained about, so one stale bundle cannot flood the console. */
const warnedActions = new Set<string>();

/**
 * One unit of work for one worker: a whole file, or one slice of one.
 *
 * The queue holds these rather than handles so that a 1.6 GB archive can occupy
 * four workers. Everything about the pool — shared queue, shift, retire when empty
 * — is unchanged; it just drains tasks now instead of files.
 */
export interface ParseTask {
    handle: WarcFileHande;
    /** Absent for a whole-file task, which is the single-worker path. */
    segment?: { index: number; count: number; start: number; end: number };
}

/**
 * Split a file into segments, or don't.
 *
 * MIN_SEGMENT is set by the largest RECORD, not by the read chunk size, and that is
 * the thing to get right. A boundary landing inside a record costs a resync scan of
 * up to one record — measured at 16.6 MB, 28.1 MB and 11.3 MB on the archives to
 * hand — so a segment smaller than that can scan past its own end and parse nothing,
 * having read more than its whole share. 64 MB is ~2x the largest seen.
 *
 * A read chunk is 8 KB. Sizing the floor off that would produce segments a thousand
 * times too small.
 *
 * Only plain .warc. A .warc.gz cannot be cut at an arbitrary byte — the byte is
 * inside a DEFLATE stream and means nothing without its member — and gzip magic is
 * three bytes, so scanning for it would find matches in compressed data constantly.
 * It is segmentable by MEMBER boundary instead, which needs an index first; see
 * segments.plan.md §8. A .wacz costs nothing either way, being already one handle
 * per archive.
 */
const MIN_SEGMENT = 64 * 1024 * 1024;

const CONTAINER_OR_GZIP = /\.(gz|wacz(\.zip)?|zip)$/i;

/**
 * The most segments this one file could ever be cut into, ignoring worker count.
 *
 * The single source of truth for "can this be shared", used both by planTasks below
 * and by the form deciding how many threads to ask for. Those two disagreeing is
 * precisely the bug that made all of this do nothing: the form capped the worker
 * count at the number of FILES, so one big archive got one worker, planTasks was
 * handed `workers = 1`, and it returned a whole-file task every time.
 *
 * Sniffing the bytes would be better and is what the worker itself does, but this
 * runs before any worker exists and the only cost of being wrong is not segmenting
 * something that could have been.
 */
export const maxSegmentsFor = (handle: WarcFileHande): number => {
    const size = handle.file?.size ?? handle.size ?? 0;

    if (size < MIN_SEGMENT * 2 || CONTAINER_OR_GZIP.test(handle.name)) return 1;

    return Math.max(1, Math.floor(size / MIN_SEGMENT));
};

/**
 * How many workers could actually be handed work by these files.
 *
 * Counts SEGMENTS, not files. One 1.6 GB archive can occupy as many workers as it
 * has 64 MB blocks, so asking for four threads on one big file is not surplus — it
 * is the whole point.
 */
export const usefulWorkers = (handles: WarcFileHande[], requested: number): number => {
    if (handles.length === 0) return 1;

    let tasks = 0;
    for (const handle of handles) tasks += maxSegmentsFor(handle);

    return Math.max(1, Math.min(requested, tasks));
};

export const planTasks = (handle: WarcFileHande, workers: number): ParseTask[] => {
    const size = handle.file?.size ?? handle.size ?? 0;
    const count = Math.max(1, Math.min(workers, maxSegmentsFor(handle)));

    if (count <= 1) return [{ handle }];

    const tasks: ParseTask[] = [];

    for (let index = 0; index < count; index++) {
        // Floor on both ends so the ranges abut exactly with no rounding gap — the
        // ownership rule needs `end` of one to be `start` of the next, or a record
        // starting in the crack would belong to nobody.
        const start = Math.floor((size * index) / count);
        const end = index === count - 1 ? size : Math.floor((size * (index + 1)) / count);

        tasks.push({ handle, segment: { index, count, start, end } });
    }

    // The slots the progress sum reads. Seeded here, where the ranges are decided,
    // so the two cannot disagree about what the segments are.
    handle.segments = tasks.map(task => ({
        start: task.segment!.start,
        end: task.segment!.end,
        at: task.segment!.start,
        done: false,
        records: 0,
        responses: 0,
    }));

    return tasks;
};

/**
 * How little of a segment is worth handing to another worker.
 *
 * Below this, the receiving worker's startup and its resync scan cost more than the
 * work it is being given — and the segment it was taken from was about to finish
 * anyway. The same reasoning as MIN_SEGMENT, at a smaller scale: half of it, because
 * a steal cuts a range in two and both halves must still be worth having.
 */
const MIN_STEAL = MIN_SEGMENT / 2;

/**
 * Ask the worker with the most left to give up its tail, for an idle worker.
 *
 * Returns whether anything was asked. The ANSWER comes back asynchronously as a
 * `resegmented` message — this only sends the request, because the cut point here is
 * computed from a progress figure that is already a frame old and the worker may be
 * past it. It replies with where it actually stopped.
 *
 * Picks by bytes remaining rather than by percent: a segment 90% through 600 MB has
 * more left than one 10% through 70 MB, and it is bytes that take time.
 */
const requestSteal = (busy: WarcWorkerHandle[]): boolean => {
    let victim: WarcWorkerHandle | null = null;
    let most = 0;

    for (const candidate of busy) {
        const claim = candidate.claim;
        if (!claim) continue;

        const slot = claim.handle.segments?.[claim.index];
        if (!slot || slot.done) continue;

        const remaining = slot.end - slot.at;
        if (remaining > most) { most = remaining; victim = candidate; }
    }

    if (!victim || most < MIN_STEAL * 2) return false;

    const claim = victim.claim!;
    const slot = claim.handle.segments![claim.index]!;

    // Halfway through what is LEFT, not through the whole segment: the front half is
    // already parsed and cutting there would hand over nothing.
    const cut = slot.at + Math.floor((slot.end - slot.at) / 2);

    victim.worker.postMessage({ action: 'resegment', segment: claim.index, end: cut });

    return true;
};

export const parseNextHandle = (
    workerHandle: WarcWorkerHandle,
    tasksToParse: ParseTask[],
    /** The pool, so an idle worker can go looking for work to take. */
    pool?: WarcWorkerHandle[],
) => {
    const task = tasksToParse.shift();
    const handle = task?.handle;

    if (!task || !handle) {
        /*
         * Nothing queued — but another worker may still be grinding through a large
         * segment. Ask it to give up its tail rather than retiring while a core sits
         * idle, which is the entire point of this.
         *
         * The worker stays alive and does nothing until the `resegmented` reply
         * arrives and queues the tail, at which point the reply handler calls back
         * in here and it picks the tail up.
         */
        if (pool && requestSteal(pool.filter(one => one !== workerHandle))) {
            workerHandle.claim = undefined;
            workerHandle.fileHandle = undefined;
            return;
        }
    }

    if (!task || !handle) {
        // Nothing left for this worker, ever: the queue is shared and only
        // drains. So it is retired here rather than left idle.
        //
        // Without this the pool never dissolved. Nobody holds the handles —
        // parseFileHandles returns them, the store passes them through, and the
        // upload form drops the array — so there was no reference left to
        // terminate through. Every press of "Process locally" added four more OS
        // threads, each holding its own copy of the parser bundle, until the tab
        // was closed.
        //
        // Safe because a terminated worker's file is already finished: `parsed`
        // is what calls back into here, and the last message a worker sends
        // arrives before it asks for its next file. Workers beyond the file
        // count are retired on their very first call, which is also right —
        // asking for four threads to parse two archives should cost two.
        workerHandle.worker.terminate();
        return;
    }

    // Only the cloneable fields cross the boundary. A WarcFileHande also carries
    // `progressCallback` (attached by the listing item on mount) and `worker`,
    // and structured clone throws DataCloneError on a function or a Worker — so
    // posting the whole handle fails outright, no matter what else is on it.
    // The File is cloneable, and it is all the worker needs to build its reader.
    //
    // The three tuning fields are passed through as-is, undefined included: the
    // worker supplies its own defaults, so this stays the one place that decides
    // what a worker is told about a file, rather than splitting that between here
    // and a set of frontend constants that would have to be kept in step.
    workerHandle.worker.postMessage({
        action: 'parseStream',
        handle: {
            name: handle.name,
            size: handle.size,
            parsedOffset: handle.parsedOffset,
            file: handle.file,
            chunkSize: handle.chunkSize,
            batchRecords: handle.batchRecords,
            batchMs: handle.batchMs,
            // Absent for a whole-file task, which keeps the worker on the path it
            // took before segmentation existed.
            ...(task.segment ? { segment: task.segment } : {}),
        },
    });

    workerHandle.fileHandle = handle;

    // What this worker is claiming, so a steal can find the busiest one. Cleared
    // when it finishes or is retired.
    workerHandle.claim = task.segment
        ? { handle, index: task.segment.index }
        : undefined;
}

/** One archive inside a container, as byte coordinates in the picked file. */
export interface ContainerArchive {
    name: string;
    dataOffset: number;
    size: number;
}

/**
 * The archives inside a container, or an empty list if it is not one.
 *
 * Asked of a throwaway worker rather than answered here, because the zip
 * central-directory reading already exists in the parser bundle — along with the
 * check that entries are STORED and the message for when they are not. Duplicating
 * it on this side would be a second implementation of the one thing that must not
 * disagree with itself.
 *
 * Never rejects. A container we cannot enumerate is still worth parsing as a single
 * file: it fails there with the same message, in the place the UI already shows
 * failures, instead of blocking file selection with an error the reader can do
 * nothing about.
 */
export const listContainerArchives = async (file: Blob): Promise<ContainerArchive[]> => {
    let worker: Worker | undefined;

    try {
        worker = new Worker(parserScriptUrl());
        const active = worker;

        return await new Promise<ContainerArchive[]>((resolve) => {
            // A number, matching the worker's own `id` field — the download and
            // view actions already use numeric ids and share the same envelope.
            const id = Date.now() + Math.floor(Math.random() * 1000);

            // A hung worker must not hold selection open forever. Ten seconds is
            // far beyond a central-directory read — two seeks and a few KB — so
            // hitting it means something is wrong, and the answer is the same as any
            // other failure: treat it as one file.
            const timer = setTimeout(() => resolve([]), 10_000);

            const done = (archives: ContainerArchive[]) => {
                clearTimeout(timer);
                resolve(archives);
            };

            active.onmessage = (event: MessageEvent) => {
                const data = event.data;

                if (data?.action !== 'archives' || data.id !== id) return;

                if (data.error) {
                    console.warn(`[warc] could not enumerate ${(file as File).name ?? 'container'}: ${data.error}`);
                    done([]);
                    return;
                }

                done(Array.isArray(data.archives) ? data.archives : []);
            };

            active.onerror = () => done([]);
            active.postMessage({ action: 'listArchives', id, file });
        });
    } catch {
        return [];
    } finally {
        // One-shot. Enumeration is two reads; keeping the worker alive for it would
        // mean owning its lifetime for the rest of the session.
        worker?.terminate();
    }
};

/**
 * @param onChange Called after every mutation of recordsRef or of a file
 * handle, so a store fronting them can tell React the data moved. Optional:
 * parsing works without it, the UI just never learns what was parsed.
 */
export const parseFileHandles = (
    workers: number,
    handles: WarcFileHande[],
    recordsRef: WarcRecordEntries,
    onChange?: () => void,
): WarcWorkerHandle[] => {
    /*
     * Synchronous, and that is the change.
     *
     * This used to be `getParserUrl().then(parserUrl => …)`, which wrapped the
     * whole function body in a promise so it could wait for a Blob of the parser
     * bundle. The url is a same-origin path now — see parserBundle.ts — so there
     * is nothing to wait for, and starting a parse no longer costs a network
     * round trip, a 190 KB copy, and a cold compile per worker.
     */
    const parserUrl = parserScriptUrl();

    /*
     * Built in a loop rather than with Array.from, so a throw partway through can
     * clean up after itself: `new Worker` failing on the fifth of twenty-four
     * used to leave four running threads with nothing left referencing them.
     */
    const workerHandles: WarcWorkerHandle[] = [];

    try {
        for (let i = 0; i < workers; i++) {
            workerHandles.push({ worker: new Worker(parserUrl) });
        }
    } catch (error) {
        workerHandles.forEach(one => one.worker.terminate());

        /*
         * Nothing started, so EVERY selected file is blocked by one cause.
         * Attributing it to each handle is what puts the reason on screen —
         * before, this was a rejected promise nobody held and the files simply
         * never moved off "Pending".
         *
         * A url that merely 404s does NOT arrive here: the Worker constructor
         * throws only for something structural, and a missing script is reported
         * asynchronously through onerror below. Hence the extra detail from the
         * warm-up, which is the one thing that has actually read the response.
         */
        const failure: WarcParseFailure = {
            stage: 'fetch-parser',
            errorName: error instanceof Error ? error.name : 'Error',
            message: [error instanceof Error ? error.message : String(error), parserScriptProblem()]
                .filter(Boolean)
                .join(' — '),
        };

        handles.forEach(handle => failHandle(handle, failure));
        onChange?.();

        console.error('parseFileHandles: could not start the parser workers', error);

        return [];
    }

    // Files that are done, or that another worker is reading right now, are not
    // queued again.
    //
    // The record store now rejects a record it already holds, so a second parse
    // could not duplicate anything — but it would still read every archive off
    // disk, decode it in full, and post thousands of records for the store to
    // throw away, while the progress bars fell from 100% back to 0. A file
    // mid-parse is worse: two workers reporting progress for one handle make the
    // bar jump between their two positions.
    //
    // 'error' is deliberately still queued. A parse that failed is exactly the
    // case where pressing the button again is the right thing to do, and the
    // records it did manage to store before failing are now what stops the retry
    // from duplicating them.
    const handlesToParse = handles.filter(
        handle => handle.status !== 'parsed' && handle.status !== 'parsing');

    /*
     * One task per file, or several for a file big enough to share.
     *
     * The spare threads go to the FIRST files rather than being spread evenly, which
     * is deliberate and is what makes a single big archive fast: with one 1.6 GB
     * file and four workers, planTasks hands back four segments and the pool takes
     * all four immediately. With five small files and four workers nothing is
     * segmented and it behaves exactly as before.
     *
     * `workers` per file rather than `workers / handles.length` because the queue is
     * shared and drains: over-planning costs nothing but a few more queue entries,
     * while under-planning leaves cores idle for the whole parse.
     */
    const tasksToParse = handlesToParse.flatMap(handle => planTasks(handle, workers));

    workerHandles.forEach((workerHandle) => {
        parseNextHandle(workerHandle, tasksToParse, workerHandles);

        workerHandle.worker.onmessage = (event) => {
            const { data } = event;

            // Every message names its file. Trusting workerHandle.fileHandle
            // instead would be a race: 'parsed' hands this worker its next file,
            // so by the time anything downstream reads that field it can already
            // point at a different archive.
            const fileHandle = workerHandle.fileHandle;

            switch (data.action) {
                case 'progress':
                    // Progress only. Deliberately does NOT call onChange: no
                    // record moved, so there is nothing in the store for the tree
                    // to re-read, and waking it would be pure waste.
                    if (fileHandle) {
                        applyProgress(fileHandle, {
                            offset: data.parsedOffset,
                            size: data.size,
                            status: 'parsing',
                            segment: data.segment,
                            segmentAt: data.segmentAt,
                            records: data.records,
                            responses: data.responses,
                        });
                    }
                    break;

                /*
                 * A worker gave up the tail of its segment. Queue it, and wake
                 * whoever is idle.
                 *
                 * `stoppedAt` is the worker's ANSWER, not the cut point we asked
                 * for: it may have parsed past our request before hearing it. Using
                 * its number rather than ours is what makes this safe — and because
                 * `stoppedAt` is a real record start, the receiving worker needs no
                 * resync at all.
                 */
                case 'resegmented': {
                    const segments = fileHandle?.segments;
                    const index = data.segment;
                    const stoppedAt = data.stoppedAt;

                    if (!fileHandle || !segments || typeof index !== 'number' || typeof stoppedAt !== 'number') break;

                    const slot = segments[index];
                    if (!slot || stoppedAt >= slot.end) break;

                    // The donor's share shrinks to what it actually parsed. Without
                    // this the sum would count the tail twice — once for the worker
                    // that gave it up and once for the one that takes it.
                    const tailEnd = slot.end;
                    slot.end = stoppedAt;
                    slot.at = Math.min(slot.at, stoppedAt);

                    // A new slot for the tail, appended so existing indices — which
                    // in-flight messages are already carrying — do not shift.
                    const tailIndex = segments.length;
                    segments.push({ start: stoppedAt, end: tailEnd, at: stoppedAt, done: false, records: 0, responses: 0 });

                    tasksToParse.push({
                        handle: fileHandle,
                        segment: { index: tailIndex, count: segments.length, start: stoppedAt, end: tailEnd },
                    });

                    // Every idle worker gets a nudge: one takes the tail, the rest
                    // find the queue empty again and may ask for another steal.
                    for (const other of workerHandles) {
                        if (other !== workerHandle && !other.fileHandle) {
                            parseNextHandle(other, tasksToParse, workerHandles);
                        }
                    }

                    onChange?.();
                    break;
                }

                // Braced, unlike its siblings, because it declares a binding —
                // a bare `let` in a case body is scoped to the whole switch.
                case 'newRecords': {
                    // Records only — the bar is driven by 'progress' above. The
                    // worker speaks WireWarcRecord (raw header bags keyed exactly
                    // as they appeared in the file) and WarcRecord is the
                    // normalised shape the UI reads. Without this translation
                    // every record arrived with url === undefined, so it was filed
                    // under an undefined key and dropped from the tree.
                    //
                    // pushRecord reports whether it kept the record; a false is a
                    // record this session already holds.
                    let stored = 0;
                    if (fileHandle && Array.isArray(data.records)) {
                        for (const wire of data.records) {
                            if (pushRecord(toWarcRecord(wire, fileHandle), recordsRef)) stored++;
                        }
                    }

                    // Once per batch rather than once per record. The store
                    // coalesces to a frame anyway, so this was never the
                    // expensive part — but there is no reason to call it 256
                    // times to schedule one flush.
                    //
                    // Skipped entirely when the whole batch was already held.
                    // Re-parsing a loaded file is now a no-op in the data, so
                    // it should be a no-op in React too: without this, parsing
                    // the same archive again still drives a frame of flushes per
                    // batch to change nothing.
                    if (stored > 0) onChange?.();
                    break;
                }

                case 'parsed':
                    // Reported BEFORE handing this worker its next file. That
                    // ordering is the whole fix: parseNextHandle overwrites
                    // workerHandle.fileHandle, so doing it the other way round
                    // marked the NEXT file complete and left the finished one
                    // parked at its last record's offset, reading "Parsing" at
                    // 99% forever. The worker's own parsedOffset is the file
                    // size, so this lands the bar on 100%.
                    /*
                     * A segment finishing is not the FILE finishing.
                     *
                     * With four workers on one archive, the first `parsed` arrives
                     * when a quarter of it is done. Reporting that as the file's
                     * status would mark a 1.6 GB parse complete at 25% and, worse,
                     * requeue nothing — the other three keep posting records into a
                     * handle the UI has already called finished.
                     *
                     * So a segmented `parsed` is reported as still 'parsing' unless
                     * it is the LAST outstanding segment. mergeSegment sets `done` on
                     * the slot; this reads back whether any remain.
                     */
                    if (fileHandle?.segments && data.segment !== undefined) {
                        const slot = fileHandle.segments[data.segment];
                        if (slot) slot.done = true;

                        const remaining = fileHandle.segments.filter(one => !one.done).length;

                        applyProgress(fileHandle, {
                            offset: data.parsedOffset ?? fileHandle.size ?? fileHandle.parsedOffset,
                            size: data.size,
                            status: remaining === 0 ? 'parsed' : 'parsing',
                            segment: data.segment,
                            segmentAt: data.segmentAt,
                            message: data.message,
                            records: data.records,
                            responses: data.responses,
                        });
                    } else if (fileHandle) {
                        applyProgress(fileHandle, {
                            offset: data.parsedOffset ?? fileHandle.size ?? fileHandle.parsedOffset,
                            size: data.size,
                            status: 'parsed',
                            // Relayed on the SUCCESS path too, not just on 'error'.
                            // A parse can complete and still have something worth
                            // saying — an archive compressed as one gzip stream
                            // parses perfectly and then makes every page view
                            // re-inflate the whole file. Dropping this here meant
                            // the worker's warning went nowhere.
                            message: data.message,
                            records: data.records,
                            responses: data.responses,
                        });
                    }

                    parseNextHandle(workerHandle, tasksToParse, workerHandles);
                    onChange?.();
                    break;

                case 'error':
                    // Same ordering rule, same reason.
                    //
                    // A segmented failure marks only ITS slot. The file is reported
                    // 'error' either way — one bad segment does mean the file is
                    // incomplete, and saying otherwise would hide it — but the
                    // remaining segments keep running and the records they have
                    // already stored are real, which is why the slot is closed out
                    // rather than the whole handle being abandoned.
                    if (fileHandle?.segments && data.segment !== undefined) {
                        const slot = fileHandle.segments[data.segment];
                        if (slot) { slot.done = true; slot.error = toParseFailure(data); }
                    }

                    if (fileHandle) {
                        applyProgress(fileHandle, {
                            offset: data.parsedOffset ?? fileHandle.parsedOffset,
                            size: data.size || (fileHandle.size ?? 0),
                            status: 'error',
                            message: data.message,
                            error: toParseFailure(data),
                            records: data.records,
                        });
                    }

                    // One bad archive — or one bad SEGMENT — costs you that, not the
                    // queue. The worker survives a decode failure, so give it the
                    // next task, which may well be another segment of the same file.
                    parseNextHandle(workerHandle, tasksToParse, workerHandles);
                    onChange?.();
                    break;

                default:
                    // Loud, because the way this goes wrong is invisible.
                    //
                    // The parser bundle is built and cached by the BACKEND, so a
                    // backend that has not restarted since the worker changed
                    // serves the old protocol — and an unhandled action is a
                    // silent `break`. Symptom: records never reach the tree and
                    // the progress bar jumps 0% straight to 100%, because the only
                    // message the handler still recognises is the final one.
                    // Nothing errors, which is what makes it expensive to find.
                    if (typeof data?.action === 'string' && !KNOWN_ACTIONS.has(data.action)) {
                        if (!warnedActions.has(data.action)) {
                            warnedActions.add(data.action);

                            // Read through the accessor: the timestamp is captured
                            // when the bundle is fetched, and that lives in
                            // parserBundle.ts, not here.
                            const builtAt = parserBundleBuiltAt();

                            const age = builtAt
                                ? `built ${builtAt} (${Math.round((Date.now() - new Date(builtAt).getTime()) / 60000)} min ago)`
                                : 'build time unknown — the backend did not send X-Parser-Built-At';

                            console.error(
                                `parseFileHandles: the parser worker sent an unknown action "${data.action}". ` +
                                `This build expects ${[...KNOWN_ACTIONS].join(', ')}. ` +
                                `The parser bundle is stale: ${age}. ` +
                                `Note that \`bun --hot\` CANNOT catch this on its own — parser/worker.entry.ts is ` +
                                `passed to Bun.build as a path and never imported, so it is not in the reload graph. ` +
                                `Restart the backend (docker compose restart webserver-archives), then hard-reload.`,
                                data,
                            );
                        }
                    }

                    break;
            }
        };

        // A worker that throws while loading — a bundle that is not valid JS,
        // an exception outside onmessage — never sends a message at all. Without
        // this the file sits at "Parsing" with no error anywhere, which is
        // exactly how a 404'd parser bundle used to present.
        workerHandle.worker.onerror = (event) => {
            const message = typeof event === 'object' && event && 'message' in event
                ? String((event as { message?: unknown }).message ?? '')
                : '';

            if (workerHandle.fileHandle) {
                // The warm-up's finding appended, when it has one. A script that
                // 404s reaches us as exactly this event and nothing else, so
                // without it the reader gets "stopped without reporting a reason"
                // for a cause that was known before the parse started.
                const detail = parserScriptProblem();

                failHandle(workerHandle.fileHandle, {
                    stage: 'worker',
                    errorName: 'WorkerError',
                    message: [
                        message || 'The parser worker stopped without reporting a reason.',
                        detail,
                    ].filter(Boolean).join(' — '),
                    offset: workerHandle.fileHandle.parsedOffset,
                });
            }

            onChange?.();
        };
    });

    return workerHandles;
};
