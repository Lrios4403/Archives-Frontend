'use client';

import type { CSSProperties } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
    downloadFailureLabels,
    downloadNoticeLabels,
    downloadStageLabels,
    isTerminal,
    type DownloadSession,
    type WarcDownloadStore,
} from "./downloads";
import { formatBytes } from "./format";
import { noticeReasonLabels } from "./notices";
import shared from "./Offline.module.css";
import s from "./downloadNotification.module.css";

/** How long a SUCCESSFUL card stays before it takes itself away. */
const AUTO_DISMISS_MS = 8000;

/** Trim a url to something readable, keeping the end where the file name is. */
const shortUrl = (url: string) => (url.length <= 52 ? url : `${url.slice(0, 24)}…${url.slice(-24)}`);

/**
 * One class on the card root, and the dot and title follow from it.
 *
 * This used to be a TONES table holding three whole Tailwind class strings per
 * outcome — edge, dot, text — because Tailwind reads the SOURCE to decide what
 * CSS to emit, so a name assembled at runtime (`border-${tone}-300`) ends up in
 * the markup and not in the stylesheet. CSS Modules has no such constraint:
 * `s.failed` is a property read, and `.failed .dot` is an ordinary selector.
 */
const toneOf = (session: DownloadSession) =>
    session.stage === 'done' ? s.done
        : session.stage === 'failed' ? s.failed
            : session.stage === 'cancelled' ? s.cancelled
                : s.running;

/**
 * The one-line summary beside the title.
 *
 * Three different numbers matter at three different moments and never all at
 * once: while walking it is how much has been found, while writing it is how much
 * of that is written, and afterwards it is what the file contains.
 */
const summarise = (session: DownloadSession): string => {
    const size = formatBytes(session.bytes);

    if (session.stage === 'walking') {
        return `${session.discovered} file${session.discovered === 1 ? '' : 's'} found`;
    }

    if (session.stage === 'writing' || session.stage === 'finishing') {
        return `${session.entries} of ${session.discovered}${size ? ` · ${size}` : ''}`;
    }

    if (session.stage === 'done') {
        return `${session.entries} file${session.entries === 1 ? '' : 's'}${size ? ` · ${size}` : ''}`;
    }

    if (session.stage === 'cancelled') {
        return session.entries > 0 ? `Stopped after ${session.entries} files` : 'Stopped';
    }

    return downloadStageLabels[session.stage];
};

/**
 * A determinate bar only once there is something determinate to show.
 *
 * During the walk the total is still growing, so a percentage would be a number
 * that goes backwards. An indeterminate stripe is the honest shape for "working,
 * total unknown", and it is what every other progress bar that cannot count
 * already uses.
 */
function DownloadBar({ session }: { session: DownloadSession }) {
    if (isTerminal(session.stage)) return null;

    const determinate = (session.stage === 'writing' || session.stage === 'finishing')
        && session.discovered > 0;

    const percent = determinate
        ? Math.min(100, Math.round((session.entries / session.discovered) * 100))
        : 0;

    return (
        <div
            className={`${shared.progressTrack} ${s.bar}`}
            role="progressbar"
            aria-valuenow={determinate ? percent : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={downloadStageLabels[session.stage]}
        >
            {determinate
                ? <div className={shared.progressFill} style={{ '--progress': percent } as CSSProperties} />
                : <div className={shared.progressFillUnknown} />}
        </div>
    );
}

function DownloadCard({
    session,
    onDismiss,
    onCancel,
    onSave,
}: {
    session: DownloadSession
    onDismiss: (id: number) => void
    onCancel?: (id: number) => void
    onSave?: (session: DownloadSession) => void
}) {
    const [showNotices, setShowNotices] = useState(false);
    const tone = toneOf(session);
    const running = !isTerminal(session.stage);

    /**
     * A card that says "Saved" removes itself. Nothing else does.
     *
     * A failure has to be read to be useful, and the reader may well have been
     * looking at something else when it happened — taking it away on a timer is
     * how a download silently fails. Cancelled stays too; it is at least a
     * question they might revisit.
     *
     * A blob card stays as well: it is holding the only copy of the archive, and
     * dismissing it is how the reader says they are finished with it.
     */
    useEffect(() => {
        if (session.stage !== 'done' || session.blob) return;

        const timer = window.setTimeout(() => onDismiss(session.id), AUTO_DISMISS_MS);

        return () => window.clearTimeout(timer);
    }, [session.stage, session.blob, session.id, onDismiss]);

    return (
        <div
            // status, not alert: a download finishing is worth announcing but not
            // worth cutting across whatever the reader is already being told.
            role="status"
            className={`${s.card} ${tone}`}
        >
            <div className={s.body}>
                <span aria-hidden className={s.dot} />

                <div className={s.main}>
                    <div className={s.head}>
                        <p className={s.title}>
                            {downloadStageLabels[session.stage]}
                        </p>
                        <p className={shared.metaDim}>{summarise(session)}</p>
                    </div>

                    <p className={`${shared.meta} ${shared.mono} ${shared.truncate}`} title={session.url}>
                        {session.name ?? shortUrl(session.url)}
                    </p>

                    <DownloadBar session={session} />

                    {/*
                      * The url in flight, only while there is one. It changes many
                      * times a second, so it is the LAST line and deliberately
                      * quiet — a reader watching the numbers should not have the
                      * layout moving under them.
                      */}
                    {running && session.at && (
                        <p className={s.inFlight} title={session.at}>
                            {shortUrl(session.at)}
                        </p>
                    )}

                    {/*
                      * The whole reason a failure card exists. The label says what
                      * happened in words; the message underneath is what the
                      * browser actually said, which is the part worth pasting into
                      * a bug report — hiding it helps nobody.
                      */}
                    {session.stage === 'failed' && session.failure && (
                        <div className={s.failureBox}>
                            <p className={s.failureLabel}>
                                {downloadFailureLabels[session.failure.reason]
                                    ?? downloadFailureLabels.unknown}
                            </p>
                            {session.failure.message && (
                                <p className={s.failureMessage}>
                                    {session.failure.errorName
                                        ? `${session.failure.errorName}: ${session.failure.message}`
                                        : session.failure.message}
                                </p>
                            )}
                            {session.failure.url && (
                                <p className={s.failureUrl} title={session.failure.url}>
                                    {shortUrl(session.failure.url)}
                                </p>
                            )}
                        </div>
                    )}

                    {/*
                      * No picker in this browser, so the archive came back as a
                      * blob and the reader has to be given somewhere to put it.
                      */}
                    {session.blob && onSave && (
                        <button
                            type="button"
                            onClick={() => onSave(session)}
                            className={s.saveButton}
                        >
                            Save the file
                        </button>
                    )}

                    {/*
                      * Non-fatal problems are folded up. A page with forty missing
                      * images is common and is not what this card is for; the count
                      * is the honest headline and the detail is one click away.
                      */}
                    {session.notices.length > 0 && (
                        <div className={s.notices}>
                            <button
                                type="button"
                                onClick={() => setShowNotices(value => !value)}
                                aria-expanded={showNotices}
                                className={s.noticesToggle}
                            >
                                {`${session.notices.length} item${session.notices.length === 1 ? '' : 's'} needed attention`}
                            </button>

                            {showNotices && (
                                <ul className={s.noticesList}>
                                    {session.notices.map((notice, index) => (
                                        <li key={`${notice.url}::${notice.kind}::${index}`} className={s.noticeItem}>
                                            <span className={s.noticeReason}>
                                                {/*
                                                  * A `missing` notice borrows the badge's
                                                  * wording, so the two cannot describe one
                                                  * gap in two different ways.
                                                  */}
                                                {notice.reason
                                                    ? noticeReasonLabels[notice.reason] ?? downloadNoticeLabels[notice.kind]
                                                    : downloadNoticeLabels[notice.kind]}
                                            </span>
                                            <span className={s.noticeUrl} title={notice.url}>
                                                {shortUrl(notice.url)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>

                <div className={s.controls}>
                    <button
                        type="button"
                        onClick={() => onDismiss(session.id)}
                        aria-label="Dismiss"
                        title={running ? 'Hide this — the download keeps going' : 'Dismiss'}
                        className={s.dismiss}
                    >
                        ✕
                    </button>

                    {/*
                      * Cancel and dismiss are DIFFERENT buttons, deliberately.
                      * Collapsing them into one ✕ means a reader tidying the corner
                      * of their screen throws away a download that was nearly
                      * finished, and there is no undo for that.
                      */}
                    {running && onCancel && (
                        <button
                            type="button"
                            onClick={() => onCancel(session.id)}
                            className={s.cancel}
                        >
                            Cancel
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Downloads, pinned to the bottom-right of the WINDOW.
 *
 * `fixed`, unlike the notice badge, which is absolute against the viewer's frame.
 * The difference is what each one is about: a notice describes the document on
 * screen and belongs against it, while a download belongs to the session and
 * carries on after that document is closed. Anchoring these to the frame would
 * mean a download vanishing the moment the reader pressed ✕ Close on the page it
 * came from.
 *
 * Newest at the BOTTOM, so a card appearing does not push the others down under
 * the pointer that is reaching for them.
 */
export default function WarcOfflineDownloadNotifications({
    downloads,
    onCancel,
    onSave,
}: {
    downloads: WarcDownloadStore
    onCancel?: (id: number) => void
    onSave?: (session: DownloadSession) => void
}) {
    const sessions = useSyncExternalStore(
        downloads.subscribe,
        downloads.getSnapshot,
        downloads.getServerSnapshot,
    );

    if (sessions.length === 0) return null;

    const finished = sessions.filter(session => isTerminal(session.stage)).length;

    return (
        <div
            className={s.dock}
            // Polite, so a card arriving is read after whatever the reader is
            // already being told rather than cutting across it.
            aria-live="polite"
            aria-label="Downloads"
        >
            {finished > 1 && (
                <button
                    type="button"
                    onClick={downloads.clearFinished}
                    className={s.clearAll}
                >
                    Clear finished
                </button>
            )}

            {sessions.map(session => (
                <DownloadCard
                    key={session.id}
                    session={session}
                    onDismiss={downloads.dismiss}
                    onCancel={onCancel}
                    onSave={onSave}
                />
            ))}
        </div>
    );
}
