'use client';

/**
 * Starting a download, and routing the worker's answers into the store.
 *
 * The mirror of view.ts on this side: the worker owns the walk and the zip, this
 * owns the file handle, the record lookups it asks for, and the session it
 * reports into.
 *
 * A download gets its OWN worker rather than the cached view worker. It holds a
 * file handle open for possibly minutes, and sharing the prewarmed one means a
 * view either waits behind it or interleaves with it — two conversations on one
 * port, with the `resolve` replies crossing.
 */


import type { WarcDownloadStore, DownloadNotice, DownloadSession } from "./downloads";
import type { WarcRecord, WarcRecordEntries } from "./types";
import { parserScriptUrl, parserScriptProblem } from "./parserBundle";
import { findNearestRecord, toPostedRecord } from "./view";

/** Session ids, so a stale message from a cancelled download can be ignored. */
let nextDownloadId = 1;

/**
 * Whether this browser can be handed a file to write into.
 *
 * Chromium only. Everywhere else the archive is built in memory and handed back
 * as a blob, which is bounded by memory but correct.
 */
export const canSaveToFile = (): boolean =>
    typeof window !== 'undefined' && typeof (window as WindowWithPicker).showSaveFilePicker === 'function';

interface WindowWithPicker extends Window {
    showSaveFilePicker?: (options: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
}

/**
 * A file name for the zip.
 *
 * NOT `archive-${customId}.zip`: customId is `file::url::uuid`, and both `:` and
 * `/` are illegal in a file name. Host, then a flattened path, then the first
 * eight of the record uuid so two captures of one page do not overwrite each
 * other in the reader's downloads folder.
 */
export const suggestedFileName = (record: WarcRecord): string => {
    let host = 'archive';
    let path = '';

    try {
        const url = new URL(record.url);
        host = url.hostname.replace(/^www\./, '');
        path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-');
    } catch {
        // Not a parseable url. The uuid below still makes the name unique.
    }

    // THE WHOLE UUID, for the same reason the entries inside the zip carry it
    // whole: a truncated one is not the WARC-Record-ID any more, just an opaque
    // tag that happens to be unique. It cannot be pasted into a search or matched
    // against a manifest, which is most of what having it in the name is for.
    //
    // `<urn:uuid:…>` unwrapped, in case a record ever arrives carrying the raw
    // header form rather than the bare id wire.ts normally produces.
    const id = record.uuid.replace(/^<?urn:uuid:/i, '').replace(/>$/, '');

    // The address is capped HERE, before the id joins it, so that trimming a long
    // url can never eat into the one part that says which capture this is.
    const stem = [[host, path].filter(Boolean).join('-').slice(0, 100), id].filter(Boolean).join('-')
        .replace(/[<>:"|?*\\/\u0000-\u001f\u007f]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    return `${stem}.zip`;
};

export interface StartDownloadOptions {
    record: WarcRecord;
    entries: WarcRecordEntries;
    downloads: WarcDownloadStore;
    /** Given the handle picked by the reader, if there was a picker. */
    handle?: FileSystemFileHandle | null;

    /**
     * How every file inside the zip is named.
     *
     * `"on-collision"` keeps readable paths and only reaches for the record id
     * when two records genuinely want one — right for saving the page you are
     * looking at.
     *
     * `"always"` gives EVERY file the `<name>.<warc>.<uuid>.<ext>` form. Right
     * when the download is about one specific capture rather than about a url,
     * because then several captures of one page are the point rather than a
     * clash to be resolved. It also means a later pass that merges more captures
     * into the same folder never has to rename what is already there — the names
     * were already unique, and they are derived from the record, so they cannot
     * move.
     */
    idPolicy?: 'on-collision' | 'always';
}

/**
 * Ask the worker to download a page, and report everything it says back.
 *
 * The picker is NOT called here — it needs transient user activation, so it has
 * to be the first thing in the click handler, before any `await`. See
 * downloadButton.tsx. This takes the handle it produced.
 *
 * Returns the session id, so a caller can cancel it.
 */
export const startDownload = async ({
    record, entries, downloads, handle, idPolicy,
}: StartDownloadOptions): Promise<number> => {
    const id = nextDownloadId++;
    const name = handle?.name ?? suggestedFileName(record);

    downloads.start(id, record.url, name);

    let worker: Worker;

    try {
        worker = new Worker(parserScriptUrl());
    } catch (error) {
        // The warm-up's finding, when it has one. A Worker constructor throws for
        // a handful of reasons and "the script is not where you think it is" is
        // the common one — the message for that lives in parserBundle, which
        // checked the url before anything needed it.
        const detail = parserScriptProblem();

        downloads.fail(id, {
            reason: 'unreadable',
            errorName: error instanceof Error ? error.name : 'Error',
            message: [error instanceof Error ? error.message : String(error), detail]
                .filter(Boolean)
                .join(' — '),
        });

        return id;
    }

    /**
     * Every message this download has finished with.
     *
     * The worker is terminated on the terminal message, but a message already in
     * flight still arrives — and a `downloadProgress` landing after the store has
     * been told the download ended would reopen a card that is done.
     */
    let settled = false;

    const finish = () => {
        if (settled) return false;
        settled = true;
        worker.terminate();
        return true;
    };

    worker.onerror = (event) => {
        if (!finish()) return;

        downloads.fail(id, {
            reason: 'unknown',
            errorName: 'WorkerError',
            message: event.message || 'The download worker stopped unexpectedly.',
            url: record.url,
        });
    };

    worker.onmessage = (event: MessageEvent) => {
        const data = event.data as {
            action?: string;
            id?: number;
            stage?: string;
            url?: string;
            entries?: number;
            discovered?: number;
            bytes?: number;
            kind?: DownloadNotice['kind'];
            detail?: string;
            reason?: string;
            errorName?: string;
            message?: string;
            notices?: DownloadNotice[];
            rootPath?: string;
            blob?: Blob;
            record?: unknown;
            requestId?: number;
            nearArchived?: string;
        };

        // Not this download's. One worker per download makes this near-impossible,
        // but the id is on every message precisely so it does not have to be
        // near-impossible to be safe.
        if (data.id !== undefined && data.id !== id
            && data.action !== 'resolve' && data.action !== 'readRecord') {
            return;
        }

        switch (data.action) {
            // The worker cannot reach the archive, so it asks — exactly as a view
            // does, through the same round trip.
            case 'resolve': {
                // Argument order is (entries, url, nearArchived) — the record
                // index first, matching how the viewer calls it.
                const found = data.url
                    ? findNearestRecord(entries, data.url, data.nearArchived ?? '')
                    : null;

                worker.postMessage({
                    action: 'resolved',
                    requestId: data.requestId,
                    record: found?.record ? toPostedRecord(found.record) : null,
                    reason: found?.record ? undefined : 'not-archived',
                    redirects: found?.redirects,
                });
                break;
            }

            case 'downloadProgress':
                downloads.progress(id, {
                    stage: data.stage as DownloadSession['stage'],
                    at: data.url,
                    entries: data.entries,
                    discovered: data.discovered,
                    bytes: data.bytes,
                });
                break;

            case 'downloadNotice':
                if (data.kind) {
                    downloads.note(id, {
                        kind: data.kind,
                        url: data.url ?? '',
                        detail: data.detail,
                        reason: data.reason as DownloadNotice['reason'],
                    });
                }
                break;

            case 'downloaded':
                if (!finish()) return;

                downloads.succeed(id, {
                    entries: data.entries ?? 0,
                    bytes: data.bytes ?? 0,
                    // The name the reader picked in the save dialog, or the one
                    // suggested to them. NOT anything the worker sends back: the
                    // worker only knows paths inside the archive.
                    name,
                    blob: data.blob,
                    notices: data.notices,
                });
                break;

            case 'downloadFatal':
                if (!finish()) return;

                downloads.fail(id, {
                    reason: (data.reason ?? 'unknown') as NonNullable<DownloadSession['failure']>['reason'],
                    errorName: data.errorName,
                    message: data.message ?? '',
                    url: data.url,
                });
                break;

            case 'downloadCancelled':
                if (!finish()) return;
                downloads.cancel(id);
                break;

            default:
                break;
        }
    };

    worker.postMessage({
        action: 'download',
        id,
        record: toPostedRecord(record),
        sink: handle ? { kind: 'file', handle } : { kind: 'blob' },
        scope: 'page',
        options: { idPolicy },
        limits: {
            // The walk is unbounded by nature — MAX_DEPTH bounds depth, not
            // breadth, and one page's link graph can reach most of an archive.
            // A cap that reports itself and still produces a valid, documented
            // zip beats a download that silently runs for an hour.
            maxEntries: handle ? 5000 : 1000,
            maxBytes: handle ? 2 * 1024 ** 3 : 256 * 1024 ** 2,
        },
    });

    // Cancellation has to reach the worker after the store has been told, so it
    // is registered rather than returned: see cancelDownload.
    cancellers.set(id, () => {
        if (settled) return;
        worker.postMessage({ action: 'cancelDownload', id });
    });

    return id;
};

/** Live downloads, by session id, so the card's Cancel button can reach one. */
const cancellers = new Map<number, () => void>();

export const cancelDownload = (id: number): void => {
    cancellers.get(id)?.();
};

/**
 * Hand a blob-sink archive to the reader.
 *
 * The fallback path for browsers with no picker: there was never a file, so the
 * only way to save it is an anchor the reader clicks.
 */
export const saveDownloadedBlob = (session: DownloadSession): void => {
    if (!session.blob || typeof document === 'undefined') return;

    const url = URL.createObjectURL(session.blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = session.name ?? 'archive.zip';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    // Revoked on a turn of the event loop rather than immediately: revoking
    // before the browser has started reading the blob cancels the save.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
