'use client';

/**
 * Turning a worker's progress reports into something a component can draw,
 * without drawing more often than the eye can tell.
 */

import { WarcFileHande, WarcParseFailure, WarcParseProgress, WarcParseProgressCallback } from "./types";

/**
 * Who to tell when a file's progress changes, held OUTSIDE the handle.
 *
 * It used to be a `progressCallback` field on WarcFileHande, which made every
 * WarcRecord unclonable — records reference their handle, so a function on the
 * handle is reachable from any record and structured clone walks the whole
 * reachable graph. `postMessage` of a single record failed on it.
 *
 * A WeakMap rather than a Map: the key is the handle itself, so when a new file
 * selection drops the old handles their callbacks go with them. Nothing has to
 * remember to clean up, and a forgotten entry cannot pin a File in memory.
 */
const progressCallbacks = new WeakMap<WarcFileHande, WarcParseProgressCallback>();

/**
 * Draw this handle's progress into `callback` until the returned function runs.
 *
 * Shaped as a subscribe so the caller's useEffect can just return it. The
 * identity check on release is the point: two mounts can race for one handle,
 * and the one leaving must not unhook the one that arrived after it.
 */
export const watchProgress = (
    handle: WarcFileHande,
    callback: WarcParseProgressCallback,
): (() => void) => {
    progressCallbacks.set(handle, callback);

    return () => {
        if (progressCallbacks.get(handle) === callback) {
            progressCallbacks.delete(handle);
        }
    };
};

/** Whole percent complete, which is all the listing can actually display. */
const percentOf = (offset: number, size: number | undefined) =>
    size && size > 0 ? Math.floor((offset / size) * 100) : 0;

/**
 * Progress reports waiting to be handed to their component, at most one per file.
 *
 * A later report for the same handle overwrites an earlier one rather than
 * queueing behind it: these are absolute state, not events, so only the newest
 * one has any bearing on what gets drawn.
 */
const pendingProgress = new Map<WarcFileHande, WarcParseProgress>();

// 0 means "nothing scheduled". Both requestAnimationFrame and setTimeout return
// ids from 1 up, so the sentinel can never collide with a real one.
let progressFrame = 0;

const flushProgress = () => {
    progressFrame = 0;

    // Snapshot and clear first: a callback runs component state setters, and one
    // of those could in principle land another report back in the map.
    const due = Array.from(pendingProgress);
    pendingProgress.clear();

    for (const [handle, progress] of due) {
        progressCallbacks.get(handle)?.(progress);
    }
};

const scheduleProgress = () => {
    if (progressFrame !== 0) return;

    progressFrame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(flushProgress)
        : (setTimeout(flushProgress, 0) as unknown as number);
};

/**
 * Record a progress report on the handle, and tell whatever is rendering it — but
 * only when the answer it would draw has actually changed.
 *
 * The handle is written FIRST, unconditionally, on every single report. That is
 * the part that must not be filtered: progressCallback only exists while a listing
 * item is mounted, so a file that finished or failed with the listing closed would
 * otherwise come back reading "Parsing" forever.
 *
 * What IS filtered is the render. A profile of five files parsing at once showed
 * the listing rows re-rendering once per record — thousands of times — through
 * this callback, while the tree beside them was coalesced to one render per frame
 * and cost nothing. Two gates fix that without the component changing at all:
 *
 *   1. Nothing is delivered unless the WHOLE PERCENT moved, the status changed, or
 *      counts or an error arrived. A 122 MB file has 100 visible states; it was
 *      reporting 2339 of them.
 *   2. What survives that is coalesced to one delivery per animation frame, which
 *      matters for a small file where nearly every batch crosses a percent
 *      boundary.
 *
 * Terminal reports bypass the coalescing entirely. "Complete" and "Failed" are the
 * two states a reader is actually waiting for, and letting a queued "Parsing"
 * flush after one of them would visibly walk the row backwards.
 */
/**
 * Fold one worker's report into a file being parsed by several.
 *
 * Returns the file's own progress figure — the SUM of what every segment has
 * finished, `Σ (at − start)`. Not the sum of positions: a worker whose share starts
 * at 1.2 GB has parsed nothing at 1.2 GB, and summing raw offsets would open the
 * file at 75%.
 *
 * Monotonic even though segments finish out of order, because each term only ever
 * rises. That is what preserves the "never walks backwards" property the worker's
 * own progress tests assert.
 */
const mergeSegment = (
    handle: WarcFileHande,
    index: number,
    at: number,
    done: boolean,
    records?: number,
    responses?: number,
): { offset: number; records: number; responses: number } | null => {
    const segments = handle.segments;

    // A report for a segment we do not know about is a stale message from a
    // previous parse of this handle. Ignoring it is right; the current totals are
    // still the answer.
    const slot = segments?.[index];
    if (!segments || !slot) return null;

    // `Math.max` on all three, so a late-arriving earlier report cannot pull a
    // segment back. The worker's counters only ever rise within one segment.
    slot.at = Math.max(slot.at, Math.min(at, slot.end));
    if (records !== undefined) slot.records = Math.max(slot.records, records);
    if (responses !== undefined) slot.responses = Math.max(slot.responses, responses);
    if (done) slot.done = true;

    let offset = 0;
    let totalRecords = 0;
    let totalResponses = 0;

    for (const segment of segments) {
        offset += segment.at - segment.start;
        totalRecords += segment.records;
        totalResponses += segment.responses;
    }

    return { offset, records: totalRecords, responses: totalResponses };
};

export const applyProgress = (handle: WarcFileHande, progress: WarcParseProgress) => {
    const previousPercent = percentOf(handle.parsedOffset, handle.size);
    const previousStatus = handle.status;

    /*
     * A segmented report updates its own slot and the file takes the sum; an
     * unsegmented one is the file's position outright, exactly as before.
     *
     * The status is the other half of this, and it is handled by the caller: a
     * worker's `parsed` means ITS SEGMENT is done, so the file only becomes
     * 'parsed' once every slot is — see workers.ts. Writing `progress.status`
     * straight through here would mark a 1.6 GB file complete when its first
     * quarter finished.
     */
    const segmented = progress.segment !== undefined;

    const merged = segmented
        ? mergeSegment(
            handle,
            progress.segment!,
            progress.segmentAt ?? progress.offset,
            progress.status === 'parsed',
            progress.records,
            progress.responses,
        )
        : null;

    /*
     * Three cases, and the third is easy to get wrong.
     *
     * A segmented report folds into its slot and the file takes the sum. An
     * unsegmented one is the file's position outright, as it always was. And a
     * SEGMENTED report we cannot attribute — a stale message from a previous parse
     * of this handle — must leave the total alone: taking `progress.offset` there
     * would overwrite the sum with one worker's raw figure, which for a segment
     * reporting its own position is not the file's progress at all.
     */
    if (merged) {
        handle.parsedOffset = merged.offset;
    } else if (!segmented) {
        handle.parsedOffset = progress.offset;
    }

    handle.status = progress.status;
    handle.message = progress.message;
    handle.error = progress.error ?? null;

    if (progress.size) handle.size = progress.size;
    /*
     * Sums for a segmented parse, the report's own figures otherwise.
     *
     * These used to be assigned straight through, which is right for one worker and
     * wrong for twenty-five: each worker counts only its own segment, so the handle
     * ended up displaying whichever segment reported last. A 1.6 GB archive holding
     * 28,000 records read "865 responses of 1,729 records" — one segment's tally —
     * while the tree itself held all of them.
     */
    if (merged) {
        handle.records = merged.records;
        handle.responses = merged.responses;
    } else if (!segmented) {
        if (progress.records !== undefined) handle.records = progress.records;
        if (progress.responses !== undefined) handle.responses = progress.responses;
    }

    /*
     * Rewrite the report to describe the FILE before anyone reads it.
     *
     * This is the step that was missing, and it made everything above look like it
     * was not working. The handle's figures were correct all along — but the report
     * is what gets delivered, and fileListing's callback reads `update.offset` and
     * `update.records` straight off it. So a segmented parse drew one worker's
     * absolute position (a bar jumping between four unrelated places in the file)
     * and one worker's tally ("1,729 records" for a 28,000-record archive) while
     * `handle.parsedOffset` sat there holding the right answer.
     *
     * Mutating the report rather than teaching each consumer to read the handle:
     * workers.ts builds a fresh object per message, so there is nothing to alias,
     * and "a progress report describes the file" is the invariant every reader
     * already assumes. The alternative is the same fix repeated at every call site,
     * which is how this went wrong once already.
     */
    if (segmented) {
        progress.offset = handle.parsedOffset;
        progress.records = handle.records;
        progress.responses = handle.responses;
    }

    const terminal = progress.status === 'parsed' || progress.status === 'error';

    const worthDrawing =
        terminal ||
        progress.status !== previousStatus ||
        progress.error != null ||
        progress.records !== undefined ||
        progress.responses !== undefined ||
        // The handle's own figure, not `progress.offset` — for a segmented parse
        // those are different numbers, and the one the bar draws is the sum that
        // mergeSegment just computed.
        percentOf(handle.parsedOffset, handle.size) !== previousPercent;

    if (!worthDrawing) return;

    if (terminal) {
        // Drop any queued mid-parse report for this file; it is now stale by
        // definition and would overwrite the final state.
        pendingProgress.delete(handle);
        progressCallbacks.get(handle)?.(progress);
        return;
    }

    pendingProgress.set(handle, progress);
    scheduleProgress();
};

/** Turn a worker `error` message into the failure the UI displays. */
export const toParseFailure = (data: {
    stage?: WarcParseFailure['stage'];
    errorName?: string;
    message?: string;
    parsedOffset?: number;
    records?: number;
}): WarcParseFailure => ({
    stage: data.stage ?? 'decode',
    errorName: data.errorName ?? 'Error',
    message: data.message ?? 'The parser failed without saying why.',
    offset: data.parsedOffset,
    records: data.records,
});

/**
 * Mark a handle failed. Used for the failures the WORKER cannot report — it
 * never received the file, or it died before it could say anything.
 */
export const failHandle = (handle: WarcFileHande, error: WarcParseFailure) =>
    applyProgress(handle, {
        offset: handle.parsedOffset,
        size: handle.size ?? 0,
        status: 'error',
        message: error.message,
        error,
    });
