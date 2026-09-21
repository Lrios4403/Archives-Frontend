'use client';

import type { CSSProperties } from "react";
import { memo, useCallback, useEffect, useState } from "react";
import { formatBytes } from "./format";
import { watchProgress } from "./progress";
import { WarcFileHande, WarcParseFailure, WarcParseProgressCallback, WarcParseStage, WarcParseStatus } from "./types";
import shared from "./Offline.module.css";
import s from "./fileListing.module.css";

const statusLabels: Record<WarcParseStatus, string> = {
    pending: 'Pending',
    parsing: 'Parsing',
    parsed: 'Complete',
    error: 'Failed',
}

/**
 * The status colour, and the progress fill that goes with it.
 *
 * These were two `Record<WarcParseStatus, string>` tables of Tailwind class
 * names. That indirection only existed because Tailwind's scanner cannot see a
 * class assembled at runtime, so every possible value had to be written out
 * somewhere it could find. A CSS-module lookup is just an object read, so the
 * tables are gone and the status name IS the class name.
 */
const fillClasses: Record<WarcParseStatus, string> = {
    pending: s.fillPending,
    parsing: s.fillParsing,
    parsed: s.fillParsed,
    error: s.fillError,
}

/**
 * The status dot, so a row's state is legible before its label is read.
 *
 * An explicit table for the same reason as the one above, and not a class name
 * assembled from the status at runtime: a typo in a template literal produces
 * `undefined` in the class list and a dot with no colour, which looks like a
 * styling glitch rather than the bug it is.
 */
const dotClasses: Record<WarcParseStatus, string> = {
    pending: s.dotPending,
    parsing: s.dotParsing,
    parsed: s.dotParsed,
    error: s.dotError,
}

/**
 * What each stage means in the reader's terms, not the code's.
 *
 * "decode" tells you nothing on its own; "the archive itself" says the file is
 * the problem, which is the difference between "re-export this WARC" and "start
 * the backend". These are the first thing shown on a failure for that reason.
 */
const stageLabels: Record<WarcParseStage, string> = {
    'fetch-parser': 'Could not load the parser from the backend',
    worker: 'The parser stopped unexpectedly',
    handle: 'The file could not be read',
    decode: 'The archive is malformed',
}


/**
 * Built once. `value.toLocaleString()` constructs a fresh Intl.NumberFormat on
 * every call, and a profile put this function at 20.8 ms in one parse — more than
 * pushRecord — purely on formatter construction.
 */
const COUNT_FORMAT = new Intl.NumberFormat();

const formatCount = (value: number) => COUNT_FORMAT.format(value);

/**
 * The failure block. Deliberately not truncated to one line like `message` is:
 * this is the one thing on the row someone actually has to read, and a parse
 * error that ends in "at byte 41231888" is unreadable clipped at the width of a
 * file name.
 */
function WarcOfflineParseFailure({ failure }: { failure: WarcParseFailure }) {
    // "Got 60 MB in and died" and "died immediately" are different problems, so
    // how far it got is part of the message rather than a detail below it.
    const reached = [
        failure.records !== undefined ? `${formatCount(failure.records)} records parsed` : null,
        // "last good record at", not "stopped at". The worker sets this from each
        // record it successfully yields, so on a failure it holds the record BEFORE
        // the bad one — the offset of the last thing that worked. Reading it as the
        // location of the fault sends you to a record that parses perfectly, which
        // is exactly the wrong place to start looking.
        failure.offset ? `last good record at byte ${formatCount(failure.offset)}` : null,
    ].filter(Boolean).join(', ');

    return (
        <div role="alert" className={s.failure}>
            <p className={s.failureStage}>{stageLabels[failure.stage]}</p>
            <p className={s.failureMessage}>
                <span className={shared.mono}>{failure.errorName}</span>: {failure.message}
            </p>
            {reached && <p className={s.failureReached}>{reached}</p>}
        </div>
    );
}

export function WarcOfflineFileListingItem({
    file,
}: {
    file: WarcFileHande;
}) {
    // The handle is a mutable object shared with the parsing workers, so seed the
    // state from it: the file may already have been parsed before this item mounted.
    const [progress, setProgress] = useState<number>(file.parsedOffset);
    const [total, setTotal] = useState<number | undefined>(file.size);
    const [status, setStatus] = useState<WarcParseStatus>(file.status ?? 'pending');
    const [message, setMessage] = useState<string | null>(file.message ?? null);
    const [failure, setFailure] = useState<WarcParseFailure | null>(file.error ?? null);
    const [counts, setCounts] = useState<{ records?: number; responses?: number }>({
        records: file.records,
        responses: file.responses,
    });

    // Purely a render callback now. progress.ts's applyProgress writes the handle
    // before calling this, so the handle stays correct whether or not this item
    // is mounted — writing it from here as well would just be a second writer
    // that only runs some of the time.
    const progressCallback = useCallback<WarcParseProgressCallback>((update) => {
        setProgress(update.offset);
        setTotal(update.size);
        setStatus(update.status);
        setMessage(update.message ?? null);
        setFailure(update.error ?? null);

        if (update.records !== undefined || update.responses !== undefined) {
            setCounts({ records: update.records, responses: update.responses });
        }
    }, []);

    // watchProgress keeps the callback in a WeakMap keyed on the handle rather
    // than as a field on it. The handle is reachable from every WarcRecord, and a
    // function anywhere on that graph makes the records unclonable — see the note
    // on WarcFileHande.
    useEffect(() => watchProgress(file, progressCallback), [file, progressCallback]);

    // Completion is a status, not a percentage. Rounding alone would show 100%
    // for a file that died in its last megabyte, so a finished parse is the only
    // thing allowed to read 100.
    const rawPercent = total ? Math.min(100, Math.round((progress / total) * 100)) : null;
    const percent = rawPercent === null
        ? null
        : status === 'parsed' ? 100 : Math.min(rawPercent, 99);

    // Responses are the captures a reader would count; records include the
    // request stored beside each one, so both are shown rather than one.
    //
    // Shown while parsing too, not just at the end: the worker sends its running
    // totals on every progress message, so this counts up as records are found
    // instead of staying blank and then revealing a number.
    const summary = counts.records !== undefined
        ? counts.responses !== undefined
            ? `${formatCount(counts.responses)} responses of ${formatCount(counts.records)} records`
            : `${formatCount(counts.records)} records`
        : null;

    return <li className={s.item}>
        {/*
          * Name, then size. The archive name from a container is
          * "container.wacz › rec-…-0.warc.gz", which is long and whose useful half
          * is the END — so it is direction-flipped to truncate on the left. A list
          * of four rows all reading "oacu-oir-nih.wacz › rec-7c53beba88…" tells you
          * nothing about which is which.
          */}
        <div className={s.head}>
            <span className={s.name} title={file.name}>{file.name}</span>
            <span className={s.size}>{formatBytes(total)}</span>
        </div>

        <div className={s.statusRow}>
            <span className={`${s.state} ${s[status]}`}>
                <span aria-hidden className={`${s.dot} ${dotClasses[status]}`} />
                {statusLabels[status]}
            </span>
            {summary && <span className={`${s.summary} ${shared.truncate}`}>{summary}</span>}
            {percent !== null && <span className={s.percent}>{percent}%</span>}
        </div>

        {percent !== null && <div
            className={`${shared.progressTrack} ${s.bar}`}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${file.name} ${statusLabels[status]}`}
        >
            <div
                className={fillClasses[status]}
                style={{ '--progress': percent } as CSSProperties}
            />
        </div>}

        {failure
            ? <WarcOfflineParseFailure failure={failure} />
            : message && <p className={`${shared.meta} ${shared.truncate} ${s[status]}`}>{message}</p>}
    </li>
}

function WarcOfflineFileListingImpl({
    files,
}: {
    files: WarcFileHande[];
    /**
     * Changes when the SELECTION changes. Not read here — it exists so the memo
     * below has something to compare, because `files` cannot serve.
     */
    revision: number;
}) {

    if (files.length === 0) {
        return <p className={s.empty}>No files selected yet.</p>
    }

    return <div className={shared.stack}>
        {/*
          * No count in the heading any more — it is on the window's titlebar, where
          * it cannot scroll out of view. Repeating it here would be the same number
          * twice, 40px apart.
          */}
        <h2 className={shared.label}>Selected files</h2>

        {/*
          * Capped and scrollable. A .wacz expands to one row per archive, so the
          * count grew by 4x for a single pick and the page grew with it — pushing
          * the Records window below the fold before anything had been parsed. Four
          * rows are visible at rest and the rest scroll.
          */}
        <ul className={s.list}>
            {/*
              * Keyed on the FILE, not on name+index. The old key collided:
              * select a.warc, parse it to 100%, then select a different set
              * whose first file is also called a.warc, and React reused the row
              * — whose progress and status are seeded by useState at mount only.
              * The new file inherited the old one's "Complete", and kept it
              * until a progress message arrived, or forever if none did.
              */}
            {files.map(file => <WarcOfflineFileListingItem key={fileKey(file)} file={file} />)}
        </ul>
    </div>
}

/**
 * A key that changes when the FILE does.
 *
 * lastModified and size distinguish two different files that share a name,
 * which is the collision the old `${name}-${index}` key could not see.
 */
const fileKey = (handle: WarcFileHande): string =>
    // `stamp` rather than `file.lastModified`: a handle's file is a Blob, which has
    // no mtime, because a container is expanded into one Blob slice per archive.
    // The stamp is the picked file's own lastModified, shared by every archive out
    // of the same container — which is fine, since their names differ.
    `${handle.name}::${handle.stamp ?? 0}::${handle.file?.size ?? handle.size ?? 0}`;

/**
 * Memoised, because its parent reads the record context.
 *
 * WarcOfflineFileUploadForm consumes the snapshot, so it re-renders on every
 * store flush — sixty times a second during a parse. That re-rendered every row
 * in this listing, which is precisely what progress.ts' two-gate coalescing
 * exists to avoid: rows subscribe to their own file's progress so they wake at
 * most ~100 times per file, and the parent was waking them anyway.
 *
 * The comparison is on `revision` ALONE, and it has to be.
 *
 * `files` is mutated in place by setFileHandles, so both snapshots hand out the
 * literally same array — `previous.files === next.files`, always. A comparator
 * that walked it was comparing the array to itself, returned "equal" every
 * time, and pinned this component on its first render: the listing mounted
 * empty and never updated again, so selected files never appeared at all even
 * though parsing them worked fine. Identity comparison cannot work on a
 * structure that is mutated in place; something has to count the changes.
 */
export default memo(WarcOfflineFileListingImpl, (previous, next) =>
    previous.revision === next.revision);
