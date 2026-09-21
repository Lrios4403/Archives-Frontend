'use client';

import { useState, useSyncExternalStore } from "react";
import { noticeReasonLabels, WarcNoticeStore } from "./notices";
import shared from "./Offline.module.css";
import s from "./noticeBadge.module.css";

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Trim a url to something readable, keeping the end where the filename is. */
const shortUrl = (url: string) => {
    if (url.length <= 60) return url;
    return `${url.slice(0, 28)}…${url.slice(-28)}`;
};

/**
 * Non-fatal problems, pinned to the bottom-right of the frame they describe.
 *
 * ABSOLUTE, not fixed: it positions against the viewer's own `relative` wrapper
 * (see iframe.tsx) rather than the window. It used to be fixed to the
 * bottom-left of the viewport, which put it diagonally opposite the frame and
 * off-screen entirely once the page was tall enough to scroll.
 *
 * The panel opens UPWARD and is right-aligned, so it grows into the document it
 * is about instead of off the edge of the container.
 *
 * `role="status"` and an expandable region rather than a dialog: this is
 * informational and non-modal, and a dialog would steal focus from the document
 * the reader is actually looking at — which, since these errors are specifically
 * the ones that did NOT stop the page rendering, is exactly the wrong trade.
 */
/**
 * `open` is deliberately NOT reset here — the caller keys this component on the
 * document being viewed, so a new page gets a new badge with `open` back at
 * false. See the note at the call site in iframe.tsx for why an effect or a
 * store flag would not have worked.
 */
export default function WarcOfflineNoticeBadge({ notices }: { notices: WarcNoticeStore }) {
    const [open, setOpen] = useState(false);

    const list = useSyncExternalStore(
        notices.subscribe,
        notices.getSnapshot,
        // Nothing has been viewed on the server, so there is nothing to report and
        // the two sides agree.
        () => EMPTY,
    );

    if (list.length === 0) return null;

    return (
        <div className={s.dock}>
            {open && (
                <div className={s.panel}>
                    <div className={s.head}>
                        <p className={s.headText}>
                            {`${list.length} resource${list.length === 1 ? '' : 's'} could not be loaded`}
                        </p>
                        <button
                            type="button"
                            onClick={notices.clear}
                            className={shared.chipButton}
                        >
                            Clear
                        </button>
                    </div>

                    <table className={s.table}>
                        <thead>
                            <tr>
                                <th scope="col">Resource</th>
                                <th scope="col">Why</th>
                                <th scope="col">Wanted by</th>
                                <th scope="col">At</th>
                            </tr>
                        </thead>
                        <tbody>
                            {/*
                              * Keyed on url + reason, with NO index.
                              *
                              * That pair is already unique among the live notices —
                              * it is the exact key `seen` dedupes on in notices.ts,
                              * so two rows cannot share one. The index made it
                              * unique-but-unstable: notices.ts trims from the FRONT
                              * at MAX_NOTICES, which shifts the index of every
                              * surviving row and remounts the whole table on the
                              * 501st notice.
                              */}
                            {list.map(notice => (
                                <tr key={`${notice.url}::${notice.reason}`}>
                                    <td className={s.cellUrl} title={notice.url}>
                                        {shortUrl(notice.url)}
                                    </td>
                                    <td className={s.cellWhy}>
                                        {noticeReasonLabels[notice.reason] ?? notice.reason}
                                    </td>
                                    <td className={s.cellRef} title={notice.referrer}>
                                        {shortUrl(notice.referrer)}
                                    </td>
                                    <td className={s.cellAt}>
                                        {TIME_FORMAT.format(notice.at)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <button
                type="button"
                onClick={() => setOpen(value => !value)}
                aria-expanded={open}
                role="status"
                className={s.badge}
            >
                <span aria-hidden className={s.dot} />
                {`[${list.length}] Non-fatal error${list.length === 1 ? '' : 's'}`}
            </button>
        </div>
    );
}

// Stable identity, or useSyncExternalStore would see a new snapshot every render
// on the server and loop.
const EMPTY: readonly never[] = [];
