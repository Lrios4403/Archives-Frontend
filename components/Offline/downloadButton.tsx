'use client';

import { useContext, useState, useSyncExternalStore } from "react";
import { WarcRecordContext } from "./context";
import { canSaveToFile, startDownload, suggestedFileName } from "./download";
import type { WarcRecord } from "./types";
import shared from "./Offline.module.css";

/**
 * Save an archived page and everything it needs, as a .zip.
 *
 * The whole reason this is its own component is the first line of the click
 * handler. `showSaveFilePicker` requires transient user activation, which is
 * spent by the first `await` — so it has to run BEFORE anything else, including
 * resolving the record or waking a worker. Called after an await it throws
 * SecurityError, and the reader gets a save dialog that never appears.
 */
export default function WarcOfflineDownloadButton({
    record,
    className,
    label = 'Download',
}: {
    record: WarcRecord
    className?: string
    label?: string
}) {
    const context = useContext(WarcRecordContext);
    const [starting, setStarting] = useState(false);

    const downloads = context?.downloads;

    const busy = useSyncExternalStore(
        downloads?.subscribe ?? neverSubscribe,
        () => downloads?.isBusy() ?? false,
        () => false,
    );

    if (!downloads || !context) return null;

    const onClick = async () => {
        // FIRST. Everything else waits.
        let handle: FileSystemFileHandle | null = null;

        if (canSaveToFile()) {
            try {
                handle = await (window as WindowWithPicker).showSaveFilePicker!({
                    suggestedName: suggestedFileName(record),
                    types: [{
                        description: 'ZIP Archive',
                        accept: { 'application/zip': ['.zip'] },
                    }],
                });
            } catch (error) {
                // Dismissing the dialog is AbortError, and it is not an error —
                // the reader changed their mind. No card, no message, nothing.
                if (error instanceof DOMException && error.name === 'AbortError') return;

                // Anything else is worth saying out loud, because no download is
                // about to start and the button will otherwise look inert.
                //
                // One id, computed once. Calling Date.now() twice gives two
                // different ids, so the failure would be filed against a session
                // that does not exist and the card would sit at "Starting"
                // forever. Negative, so it cannot collide with a real session.
                const failed = -Date.now();

                downloads.start(failed, record.url, suggestedFileName(record));
                downloads.fail(failed, {
                    reason: 'no-sink',
                    errorName: error instanceof Error ? error.name : 'Error',
                    message: error instanceof Error ? error.message : String(error),
                    url: record.url,
                });

                return;
            }
        }

        setStarting(true);

        try {
            await startDownload({ record, entries: context.recordEntries, downloads, handle });
        } finally {
            setStarting(false);
        }
    };

    return (
        <button
            type="button"
            onClick={() => { void onClick(); }}
            // Disabled only while a download is actually running: the worker
            // refuses a second one with `busy`, and a button that reports that as
            // a failure card is worse than one that cannot be pressed.
            disabled={busy || starting}
            title={busy
                ? 'A download is already running'
                : 'Save this page and its resources as a .zip'}
            className={className ?? shared.chipButton}
        >
            {starting ? '…' : label}
        </button>
    );
}

interface WindowWithPicker extends Window {
    showSaveFilePicker?: (options: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
}

/** A subscribe that never fires, for a render with no store behind it. */
const neverSubscribe = () => () => {};
