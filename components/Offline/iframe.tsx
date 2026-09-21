'use client';

import { useContext, useEffect, useRef, useState } from "react";
import Window from "@/components/Window/Window";
import { WarcRecordContext, WarcViewContext } from "./context";
import WarcOfflineDownloadButton from "./downloadButton";
import { displayRecordId, formatBytes, payloadSize } from "./format";
import WarcOfflineNoticeBadge from "./noticeBadge";
import WarcOfflineViewProgress from "./viewProgressOverlay";
import { fetchArchived, navigateArchived, prewarmViewWorker } from "./view";
import { resetPrefs, setPref, usePrefs, type OfflinePrefs } from "./prefs";
import { registerArchiveViewer, settleArchiveViewer } from "./viewerFocus";
import type { WarcRecord } from "./types";
import shared from "./Offline.module.css";
import s from "./iframe.module.css";
import n from "../shared/notice.module.css";

/**
 * A url as a reader wants to read it: `example.com/coolio`.
 *
 * The scheme is dropped because it is the same on every row and costs eight
 * characters of a line that is already tight. The full url stays in `title`, so
 * nothing is actually lost — and a non-https scheme is kept visible, since on a
 * page of otherwise-https captures that IS the interesting part.
 */
const displayUrl = (raw: string): string => {
    try {
        const url = new URL(raw);
        const bare = `${url.host}${url.pathname}${url.search}`;

        if (url.protocol === 'https:') return bare.replace(/\/$/, '') || url.host;

        return `${url.protocol}//${bare}`;
    } catch {
        return raw;
    }
};

/** Built once: an Intl formatter per row is measurably worse than reusing one. */
const TRAIL_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

/*
 * The address line and every history row share one column template —
 * `.addressGrid` in Offline.module.css.
 *
 * A GRID, and a shared one, because the first attempt at this was flex with
 * `flex-1` on both the url and the id — which makes each track's width depend on
 * what is in the OTHER columns. The address line ends in a type and a size, a
 * history row ends in a date, so no two lines agreed on where the middle column
 * began: the ids landed at a different offset on every row and read as scattered
 * rather than as a column.
 *
 * It was an inline style object shared by both call sites so the two could not
 * drift. `composes: addressGrid` does the same thing, and the class can carry a
 * breakpoint the object could not: on a phone the fixed 15.5rem id column is
 * most of the screen, so it is the first thing dropped.
 */

/**
 * Where the reader has been, over the top of the page they are on.
 *
 * Newest first, which is the order a Back button implies — the entry you would
 * reach next is the one under the cursor, not the one at the bottom of a list.
 *
 * Absolutely positioned so opening it costs the document no height: the iframe is
 * a fixed 70vh and a panel in the flow would push it down, moving the page under
 * the pointer at the moment the pointer is being used to point at it.
 */
const WarcOfflineTrailPanel = ({
    trail,
    index,
    onPick,
}: {
    trail: readonly WarcRecord[]
    index: number
    onPick: (index: number) => void
}) => (
    // Two elements, not one: the outer is the hoverable bridge across the gap
    // (see .trail in the stylesheet), the inner is the menu. role="menu" belongs
    // on whichever one directly contains the menuitems, so it goes on the inner.
    <div className={s.trail}>
        <div role="menu" aria-label="Pages visited" className={s.trailPanel}>
            {/* Indices counted down, so each row still knows its real position. */}
            {Array.from({ length: trail.length }, (_, offset) => trail.length - 1 - offset).map(at => {
                const record = trail[at];
                const current = at === index;

                return (
                    <button
                        key={`${record.customId}:${at}`}
                        type="button"
                        role="menuitem"
                        onClick={() => onPick(at)}
                        aria-current={current ? 'page' : undefined}
                        className={`${s.trailRow}${current ? ` ${s.trailRowCurrent}` : ''}`}
                    >
                        <span aria-hidden className={s.trailMarker}>{current ? '▸' : ''}</span>
                        <span className={s.trailUrl} title={record.url}>
                            {displayUrl(record.url)}
                        </span>
                        {/*
                          * The same middle column as the header, for the same reason: a
                          * trail through six captures of one thread page is six identical
                          * rows without it.
                          */}
                        <span className={s.trailId} title={record.customId}>
                            {displayRecordId(record)}
                        </span>
                        <span className={s.trailAt}>
                            {TRAIL_TIME_FORMAT.format(record.dateArchived)}
                        </span>
                    </button>
                );
            })}
        </div>
    </div>
);

/*
 * The frame's empty state, and the page's <h1>.
 *
 * The viewer sits at the top of the page with nothing above it, which is how
 * the page owner wants it, so this card is the first thing a reader and a
 * crawler meet. It therefore does the heading's job: says what the tool is, in
 * the words people search for, and then says how to use it — one paragraph,
 * not a manual. Everything longer lives behind "More Information", which is a
 * plain fragment link to the #about container (see app/warcs/offline/page.tsx;
 * the switch is CSS :target, no script).
 *
 * "without a server" is deliberately absent from the wording: the parser bundle
 * is fetched from this site (parserBundle.ts). What IS true, and what the reader
 * cares about, is that the files never leave the machine.
 */
/**
 * What "Don't show again" has switched off, in one line — or nothing.
 *
 * Both redirect bars have a "Don't show again". The choice lasts for this visit
 * (see prefs.ts), so a reload would undo it — but a reload also throws away
 * every archive the reader has parsed, which is a steep price for one
 * mis-click. This is the cheap route back. It appears ONLY while a preference
 * is set, and only in the empty state: a reader who chose silence should not
 * be told about it on every page, but should find the switch when they look.
 */
const RedirectPrefsNote = ({ prefs }: { prefs: OfflinePrefs }) => {
    if (!prefs.followRedirectsWithBody && !prefs.hideRedirectedNotice) return null;

    const what = prefs.followRedirectsWithBody && prefs.hideRedirectedNotice
        ? 'Redirects are followed silently'
        : prefs.followRedirectsWithBody
            ? 'Redirects are followed without asking'
            : 'Redirect notices are hidden';

    return (
        <p className={s.tutorialPrefs}>
            {what}
            {' · '}
            <button type="button" className={s.tutorialReset} onClick={resetPrefs}>
                Show them again
            </button>
        </p>
    );
};

/*
 * The empty state is this page's hero, because the page has no header above the
 * viewer — that was removed deliberately so the tool comes first. So this card
 * carries the <h1> and has to answer, in the first screenful: what is it, what
 * does it open, is it online, does it upload, what can you do with it.
 *
 * The claim row is four facts, not marketing. Each one is either true of the
 * code or it does not belong here: nothing is uploaded (parsing is in Workers
 * over a local File), there is no account, there is no install, and the formats
 * are exactly fileUpload.tsx's ACCEPTED_EXTENSIONS.
 */
const CLAIMS = ['No upload', 'No account', 'No install', '.warc · .warc.gz · .wacz'];

const WarcOfflineIFrameTutorial = ({ prefs }: { prefs: OfflinePrefs }) => (
    <div className={s.tutorial}>
        <h1 className={s.tutorialTitle}>WARC Viewer Online</h1>
        <p className={s.tutorialSub}>
            Open <strong>.warc</strong>, <strong>.warc.gz</strong> and <strong>.wacz</strong> web archives
            directly in your browser. Choose one or more archives in <strong>Load archives</strong> below and
            press <strong>Process Locally</strong>; every URL they captured appears in{' '}
            <strong>Records</strong>, grouped by site. Click a capture to replay it in this frame from its
            captured response — with back and forward, a trail of what you have visited, and the raw HTTP
            headers. Your archives are parsed on your own machine and never uploaded.
        </p>
        <ul className={s.tutorialClaims}>
            {CLAIMS.map(claim => <li key={claim}>{claim}</li>)}
        </ul>
        <p className={s.tutorialMore}>
            <a href="#about" className={s.tutorialLink}>More Information →</a>
        </p>
        <RedirectPrefsNote prefs={prefs} />
    </div>
);

/** What each fatal reason means to a reader, rather than to the code. */
const fatalLabels: Record<string, string> = {
    'not-archived': 'That page is not in these archives',
    'no-payload': 'That capture stored no page',
    'unreadable': 'The archive file could not be read',
    // Redirects are followed now, so reaching this means the chain never landed:
    // it loops, or it is longer than the resolver will walk.
    'redirect': 'That link redirects in a loop',
    'decode': 'That capture could not be turned into a page',
};

export default function WarcOfflineIFrameViewer() {
    // The actions and the record index, whose identity never changes — so this
    // subscription cannot re-render the frame.
    const context = useContext(WarcRecordContext);
    // What is on screen. The only thing here that moves, and it moves on
    // navigation rather than on every frame of a parse.
    const view = useContext(WarcViewContext);
    const frameRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [trailOpen, setTrailOpen] = useState(false);

    /*
     * The address a click asked for, when it was not the one that rendered.
     *
     * navigateArchived follows a redirect chain and hands back the DESTINATION's
     * record — which is right, and completely silent about itself. A reader
     * clicks /posts/208882 and finds themselves on page-902 of a thread with
     * nothing anywhere saying why. /warcs/view grew a notice for this; the two
     * viewers should not disagree about whether that is worth mentioning.
     *
     * Stored WITH the record it belongs to rather than cleared by an effect. The
     * notice is set during the same navigation that changes the view, so an
     * effect keyed on the view would race it and clear the thing it just set.
     * Keying on the destination means any other navigation stops matching and the
     * notice disappears on its own.
     */
    const [redirected, setRedirected] = useState<{ from: string; to: string } | null>(null);

    const prefs = usePrefs();

    /*
     * A redirect the frame is SHOWING rather than following — a 3xx with a body.
     * Comes from the view itself, so it appears whoever navigated here (a link,
     * the timeline, the tree, the arrows). `from` is the page on screen; `to` is
     * where its Location header points.
     */
    const viewing = view?.viewingRecord ?? null;
    const pending = viewing && view?.viewingRedirectsTo
        ? { from: viewing.url, to: view.viewingRedirectsTo }
        : null;

    // The "Redirected from" bar: only for the page it was set for, and only
    // while the reader has not asked never to see it.
    const showRedirected = redirected !== null
        && redirected.to === viewing?.customId
        && !prefs.hideRedirectedNotice;

    /*
     * Only the newest click may win. Two links clicked in quick succession
     * resolve concurrently and settle in whatever order the archive reads them,
     * so without this the SLOWER one lands last and the reader ends up on the
     * page they did not pick second. A ref, so the link handler installed below
     * and the Redirect button share one counter for the whole session.
     */
    const latestClick = useRef(0);

    const trail = view?.viewTrail ?? [];
    const viewingSize = formatBytes(payloadSize(view?.viewingRecord?.payload));

    /**
     * Point the frame at the built document WITHOUT adding a history entry.
     *
     * Assigning `src` is a navigation, and a navigation in a nested frame pushes
     * onto the tab's session history — so the browser accumulated one entry per
     * archived page, each naming a blob url that this store revokes the moment the
     * next page is shown. Pressing Back walked the iframe to a revoked blob, which
     * resolves to nothing: the frame emptied.
     *
     * location.replace reuses the frame's current entry instead. The entries the
     * reader actually wants are pushed deliberately by the store, one per archived
     * page, and carry a trail position rather than a blob url — see browserHistory.
     *
     * Falls back to the attribute if the frame has no document yet, which is only
     * the first render. allow-same-origin is what makes contentWindow reachable at
     * all; that was already a deliberate choice for archived scripts, and this
     * depends on it.
     */
    useEffect(() => {
        const frame = iframeRef.current;
        const url = view?.recordBlobUrl;

        if (!frame || !url) return;

        try {
            const inner = frame.contentWindow;

            if (inner) {
                inner.location.replace(url);
                return;
            }
        } catch {
            // Cross-origin, or a frame mid-teardown. The attribute still works;
            // it just costs the history entry this is here to avoid.
        }

        frame.src = url;
    }, [view?.recordBlobUrl]);

    // Closed on every navigation. The panel describes where the reader HAS been,
    // so leaving it open over a page they just arrived at means the list under the
    // pointer no longer means what it meant when they moved the pointer there.
    useEffect(() => { setTrailOpen(false); }, [view?.recordBlobUrl]);

    /*
     * Correct the aim of the View click, now that the document is in the frame.
     *
     * The click scrolled before the rebuild — deliberately, so the reader is at
     * the frame while it fills rather than after — which means it measured the
     * frame at its old height and centred against that. A document is 70vh; the
     * empty state and the tutorial are not. No-op unless a View press armed it,
     * so this cannot fire for a link followed inside an archived page.
     */
    useEffect(() => { settleArchiveViewer(!!view?.recordBlobUrl); }, [view?.recordBlobUrl]);

    /**
     * Register as the scroll target, and get the worker running.
     *
     * The prewarm is here rather than in the provider because this component is
     * the only thing that ever shows a view — a page with the provider but no
     * viewer has no use for a worker, and starting one would be a fetch and a
     * thread for nothing.
     */
    useEffect(() => {
        const cancelPrewarm = prewarmViewWorker();
        const unregister = registerArchiveViewer(frameRef.current);

        return () => {
            // Both, and the prewarm first: it is the one with a pending timer, and
            // a reader who navigated straight past this page should not be charged
            // a 190 KB cross-origin fetch for a viewer that is already gone.
            cancelPrewarm();
            unregister();

            // Leaving the viewer ends the visit. A reload resets the redirect
            // preferences by itself (module state); an in-app navigation to
            // another route does not, because the module stays loaded — so it
            // is done here, where "the viewer went away" is a fact.
            resetPrefs();
        };
    }, []);

    /**
     * Following a link inside an archived page.
     *
     * The guard injected into every rebuilt document cancels the real navigation
     * and posts here instead, so this is where a click actually goes.
     *
     * The origin check is not security — a blob: document reports its origin as
     * "null", so there is nothing to compare against and anything on the page can
     * post this. It is a shape check, to avoid acting on unrelated postMessage
     * traffic that happens to share the window.
     */
    /**
     * The latest context, without making the listener depend on it.
     *
     * The message effect below used to list `context` as a dependency, which was
     * quietly wrong twice over: the store hands out a new snapshot on every
     * animation frame, so during a parse the window listener was removed and
     * re-added sixty times a second — and, worse, `latestClick` was re-created
     * with it. That counter is the whole defence against two quick link clicks
     * landing out of order, and it was being reset between them.
     */
    const contextRef = useRef(context);
    const viewRef = useRef(view);

    useEffect(() => {
        contextRef.current = context;
        viewRef.current = view;
    }, [context, view]);

    useEffect(() => {
        const onNavigate = (context: NonNullable<typeof contextRef.current>, data: { url: string; from?: unknown }) => {
            const mine = ++latestClick.current;
            const from = typeof data.from === 'string' ? data.from : null;

            void navigateArchived(data.url, from, context.recordEntries).then(outcome => {
                if (mine !== latestClick.current) {
                    if (outcome.ok) outcome.revoke();
                    return;
                }

                if (outcome.ok) {
                    // Compared on the ARCHIVED address, which is what the reader
                    // asked for — `outcome.url` is a blob uuid and never matches.
                    setRedirected(
                        outcome.documentUrl && outcome.documentUrl !== data.url
                            ? { from: data.url, to: outcome.record.customId }
                            : null,
                    );

                    context.showBlob?.(outcome);
                } else {
                    setRedirected(null);
                    context.showViewFailure?.(outcome);
                }
            });
        };

        /**
         * Answering a request the page made for itself.
         *
         * The shim in the guard cannot reach the archive — it is inside a blob:
         * document with no access to the File the records live in — so it asks,
         * and this is the side that can look. Replies go back to the window that
         * asked rather than being broadcast.
         */
        const onFetch = (
            context: NonNullable<typeof contextRef.current>,
            event: MessageEvent,
            data: { id: number; url: string; from?: unknown },
        ) => {
            const source = event.source as Window | null;

            /*
             * `viewRef.current`, NOT `view`.
             *
             * This listener is installed once, with [] deps, so `view` here is
             * whatever it was on the first render — which is null, because nothing
             * is being viewed until the reader opens something. That made `from`
             * fall back to '' and `near` to `new Date()`, so every runtime fetch
             * from an archived page's own JS resolved against TODAY.
             *
             * nearestCapture picks the capture closest to `near`, so the effect was
             * to hand a 2019 page whichever copy of an asset was crawled most
             * recently — exactly the mismatch the "nearest, not newest" rule in
             * view.ts exists to prevent, and invisible unless you knew which
             * capture you should have got.
             *
             * The ref was already here and already being written for this; it was
             * simply never read.
             */
            const showing = viewRef.current?.viewingRecord;
            const from = typeof data.from === 'string' ? data.from : showing?.url ?? '';
            const near = showing?.dateArchived.toISOString() ?? new Date().toISOString();

            void fetchArchived(data.url, near, context.recordEntries).then(result => {
                if (!result.ok) {
                    // A runtime request the archive cannot answer is exactly the
                    // gap `dynamic` was reserved for. Reported rather than
                    // silently failed: from the page's side this looks like a
                    // network error, and the reader deserves to know it was the
                    // archive and not the code.
                    context.reportMissing?.(from || result.url, [
                        { url: result.url, reason: 'dynamic', referrer: from || result.url },
                    ]);
                }

                source?.postMessage(
                    result.ok
                        ? {
                            type: 'warc-fetch-result', id: data.id, ok: true,
                            url: result.url, status: result.status,
                            contentType: result.contentType, bytes: result.bytes,
                        }
                        : { type: 'warc-fetch-result', id: data.id, ok: false, url: result.url },
                    '*',
                    // Transferred, so a large body is not copied a third time.
                    result.ok ? [result.bytes] : [],
                );
            });
        };

        const onMessage = (event: MessageEvent) => {
            const data = event.data;

            // Read at CALL time, not capture time — which is the point of the
            // ref. The listener is installed once and must still see whatever
            // the store is holding now.
            const context = contextRef.current;
            if (!context) return;

            if (data?.type === 'warc-navigate' && typeof data.url === 'string') {
                onNavigate(context, data);
                return;
            }

            if (data?.type === 'warc-fetch' && typeof data.url === 'string' && typeof data.id === 'number') {
                onFetch(context, event, data);
            }
        };

        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
        // Installed ONCE. See contextRef above.
    }, []);

    /**
     * Follow the redirect the page on screen names: the "Follow →" button, and
     * the destination address itself.
     *
     * followBodiedRedirects is true for THIS navigation only. The reader has just
     * said "yes, go", so a chain of two interstitials should not ask twice — but
     * the next bodied redirect they click into on their own should. The bar that
     * appears afterwards says where they came from, exactly as it does for a
     * redirect the viewer followed by itself.
     */
    const followRedirect = (to: string, from: string) => {
        const context = contextRef.current;
        if (!context) return;

        const mine = ++latestClick.current;

        void navigateArchived(to, from, context.recordEntries, { followBodiedRedirects: true }).then(outcome => {
            if (mine !== latestClick.current) {
                if (outcome.ok) outcome.revoke();
                return;
            }

            if (outcome.ok) {
                setRedirected({ from, to: outcome.record.customId });
                context.showBlob?.(outcome);
            } else {
                setRedirected(null);
                context.showViewFailure?.(outcome);
            }
        });
    };

    /**
     * Is there actually a page in the frame?
     *
     * Three things key off this and they must agree: whether the titlebar is an
     * address bar or a title, whether the window is flush, and which of the
     * three bodies renders. A failure takes precedence over a stale blob url —
     * the failure is shown IN PLACE OF the document, so a titlebar still
     * offering Back/Save for the page that did not load would be lying.
     */
    const showingDocument = !view?.viewFailure && Boolean(view?.recordBlobUrl);

    /**
     * The frame, in whatever state it is in.
     *
     * A value rather than an early return from each branch, so the notice badge
     * can be attached once and cover all three. A reader who closed a page, or
     * landed on one that would not render, has not stopped caring about what the
     * last few pages could not find.
     */
    const body = (() => {
        // Fatal errors are shown IN PLACE OF the document. Nothing rendered, so a
        // reader looking at an empty frame needs the reason here, not in a badge
        // in the corner that they may never open.
        if (view?.viewFailure) {
            const failure = view?.viewFailure;

            return (
                <div role="alert" className={s.fatal}>
                    <p className={s.fatalTitle}>
                        {fatalLabels[failure.reason] ?? 'That page could not be shown'}
                    </p>
                    <p className={s.fatalUrl}>{failure.url}</p>
                    <p className={s.fatalDetail}>
                        <span className={shared.mono}>{failure.errorName}</span>: {failure.message}
                    </p>
                    <button
                        type="button"
                        onClick={context?.clearView}
                        className={s.fatalDismiss}
                    >
                        Dismiss
                    </button>
                </div>
            );
        }

        if (!view?.recordBlobUrl) return <WarcOfflineIFrameTutorial prefs={prefs} />;

        return (
            <>
                {/*
                  * allow-same-origin is deliberate and is NOT a security boundary:
                  * archived scripts run with this origin, by decision. It is set
                  * explicitly so the choice is visible rather than inherited.
                  *
                  * No `src`, deliberately. The effect above drives this with
                  * location.replace so that navigating between archived pages does
                  * not push a session-history entry per page — see the note there.
                  * about:blank is the starting document, and it is same-origin, so
                  * contentWindow is reachable from the first render.
                  */}
                <iframe
                    ref={iframeRef}
                    src="about:blank"
                    title="Archived page"
                    sandbox="allow-scripts allow-same-origin allow-forms"
                    className={s.document}
                />
            </>
        );
    })();

    /**
     * The address bar — which is the window's TITLEBAR, not a strip under it.
     *
     * This is what a browser does, and the reason to copy it here is that the
     * two were saying the same thing twice: a bar reading "VIEWER" sat directly
     * above a row reading "5amgirlfriend.neocities.org/about/ohayo". The window
     * is the page; the page's address is its title.
     *
     * Rendered only with a document behind it. With none, the window keeps an
     * ordinary title, because back/forward/Save/Close over an empty frame are
     * four controls that all do nothing.
     */
    const addressBar = !showingDocument ? undefined : (
        <div className={s.addressRow}>
            <div className={s.navPair}>
                <button
                    type="button"
                    onClick={context?.goBack}
                    disabled={!view?.canGoBack}
                    aria-label="Back"
                    title="Back"
                    className={s.navButton}
                >
                    ←
                </button>
                <button
                    type="button"
                    onClick={context?.goForward}
                    disabled={!view?.canGoForward}
                    aria-label="Forward"
                    title="Forward"
                    className={s.navButton}
                >
                    →
                </button>
            </div>

            {/*
              * Address, then type, then size — "example.com/coolio | text/html |
              * 30.2 KB". The address is what a reader is actually tracking as
              * they click around, and after a redirect it is the only thing that
              * says where they ended up; the size is the one number that says
              * whether the whole page was captured or a truncated stub of it.
              *
              * `relative` anchors the trail panel to this line rather than to the
              * frame, so the panel opens under the address it belongs to whatever
              * else is on the row.
              */}
            <div
                className={s.addressWrap}
                onMouseEnter={() => setTrailOpen(true)}
                onMouseLeave={() => setTrailOpen(false)}
                // Hover cannot be the only way in: there is nothing to hover with
                // a keyboard, and a hover-only panel does not exist at all on a
                // touch screen. So the button toggles it too, and Escape closes
                // it — bubbling up from whichever row has focus.
                onKeyDown={event => { if (event.key === 'Escape') setTrailOpen(false); }}
            >
                {/*
                  * Address, which capture, what it is — on .addressGrid, the same
                  * template the history rows use, so the three read as columns
                  * rather than as three lines that happen to contain similar
                  * things.
                  *
                  * The middle column exists because several captures of one
                  * address are the normal case in an archive, and with only the
                  * url on screen they are indistinguishable — the reader cannot
                  * tell which of six copies of a thread page they are reading.
                  * The record's own id is the thing that differs.
                  *
                  * The empty first cell is the marker column. It carries no
                  * marker here, and pays for it in 12px, so that the header's url
                  * starts exactly above the rows' urls.
                  */}
                <button
                    type="button"
                    onClick={() => setTrailOpen(open => !open)}
                    aria-expanded={trailOpen}
                    aria-haspopup="menu"
                    disabled={trail.length === 0}
                    title={view?.viewingRecord?.url}
                    className={s.address}
                >
                    <span aria-hidden />

                    <span className={s.addressUrl}>
                        {view?.viewingRecord ? displayUrl(view.viewingRecord.url) : '—'}
                    </span>

                    <span
                        className={s.addressRecord}
                        // The whole customId here — file, url and id. The file
                        // name is worth having, just not worth the width.
                        title={view?.viewingRecord?.customId}
                    >
                        {displayRecordId(view?.viewingRecord)}
                    </span>

                    <span className={s.addressType}>
                        {view?.recordBlobType}
                        {viewingSize && ` | ${viewingSize}`}
                    </span>
                </button>

                {/*
                  * Only with somewhere to go. A one-entry panel offering the page
                  * you are already on is a menu that does nothing.
                  */}
                {trailOpen && trail.length > 1 && (
                    <WarcOfflineTrailPanel
                        trail={trail}
                        index={view?.viewIndex ?? -1}
                        onPick={index => {
                            setTrailOpen(false);
                            context?.goToView?.(index);
                        }}
                    />
                )}
            </div>

            {/*
              * Download saves the page ON SCREEN, so it belongs beside the
              * address that names it rather than in the record listing — by the
              * time a reader wants a copy, they are looking at it.
              */}
            {view?.viewingRecord && (
                <WarcOfflineDownloadButton
                    record={view.viewingRecord}
                    label="⤓ Save"
                    className={s.titleChip}
                />
            )}

            <button
                type="button"
                onClick={context?.clearView}
                className={s.titleChip}
            >
                ✕ Close
            </button>
        </div>
    );

    return (
        <Window
            // The accessible name stays a name even when the visual title is a
            // control surface — a screen reader announcing "5amgirlfriend…,
            // group" needs the url, and an empty viewer needs something.
            // "WARC Viewer", matching the nav and the page header. The URL still
            // says offline and the FAQ explains why; the chrome no longer leads
            // with a word that reads as "not online" to a first-time visitor.
            title={showingDocument && view?.viewingRecord
                ? view.viewingRecord.url
                : 'WARC Viewer'}
            icon={showingDocument ? undefined : '🌐'}
            titleContent={addressBar}
            // Flush with a document, because the iframe IS the content and a
            // 24px inset around it just makes the page smaller. Padded without
            // one, because the tutorial and the failure card are prose.
            flush={showingDocument}
        >
            {/*
              * `relative` is what the badge anchors itself to. Without it the
              * badge would position against the nearest positioned ancestor, or
              * failing that the viewport — which is where it used to sit, three
              * quarters of a page away from the frame it was describing.
              *
              * tabIndex -1 so focusArchiveViewer can land here. Not focusable by
              * tabbing — it is a scroll and announcement target, not a control.
              */}
            <div ref={frameRef} tabIndex={-1} className={s.frame}>
                {body}

                {/*
                  * Top of the frame for progress, bottom-right for notices: one
                  * is transient and about the page arriving, the other persists
                  * and is about what did not. Opposite corners so a slow page
                  * with gaps in it does not stack two panels on top of each
                  * other.
                  */}
                <WarcOfflineViewProgress />

                {/*
                  * One column, pinned to the bottom of the frame: the non-fatal
                  * badge above, the notice bars below, a small gap between.
                  *
                  * The two used to position themselves independently — the bar
                  * at bottom:8px, the badge dock at bottom:12px and a higher
                  * z-index — so whenever both were up the badge sat on the bar's
                  * right-hand end, which is where Dismiss is. One bottom-anchored
                  * column makes the geometry a fact of layout rather than of two
                  * numbers agreeing: it grows upward, and nothing overlaps.
                  * Absolutely positioned as a whole, so it still costs the frame
                  * no height and cannot push the document the reader is reading.
                  */}
                <div className={s.bottomStack}>
                    {/*
                      * Keyed on the document, so each one gets its own badge.
                      *
                      * The badge's expanded/collapsed state is local, and clearing
                      * the store on a view transition does not reset it. It looks
                      * like it should: the store empties, `list.length === 0`
                      * returns null, the component unmounts and its state goes with
                      * it. It does not, because displayView clears and re-adds in
                      * the SAME tick — React batches the two emits, re-reads the
                      * snapshot once, and sees only the final non-empty list. The
                      * empty moment never reaches the component, so it never
                      * unmounts, so an expanded panel stayed expanded across every
                      * navigation and had to be closed again on each page.
                      *
                      * A key says the thing that is actually true — this badge
                      * belongs to this document — and does not depend on batching
                      * behaviour to hold.
                      */}
                    {context?.notices && (
                        <WarcOfflineNoticeBadge
                            key={view?.viewingRecord?.customId ?? 'empty'}
                            notices={context.notices}
                        />
                    )}

                    {/*
                      * Same bars as /warcs/view, from the same stylesheet — see
                      * components/shared/notice.module.css. Two of them can be up
                      * at once: a body-less 301 followed INTO a bodied 302 shows
                      * "Redirected from" the first and "Redirecting to" the
                      * third, which is the truth of where the reader is.
                      */}
                    {(pending || showRedirected) && (
                        <div className={`${n.notices} ${s.stackedNotices}`}>
                            {pending && (
                                <p role="status" className={n.notice}>
                                    <span className={n.label}>Redirecting</span>
                                    <span className={n.muted}>to</span>
                                    <button
                                        type="button"
                                        className={`${n.url} ${s.urlLink}`}
                                        title={pending.to}
                                        onClick={() => followRedirect(pending.to, pending.from)}
                                    >
                                        {pending.to}
                                    </button>
                                    <button
                                        type="button"
                                        className={n.action}
                                        onClick={() => followRedirect(pending.to, pending.from)}
                                    >
                                        Follow →
                                    </button>
                                    {/*
                                      * "Don't show again" here means "stop waiting
                                      * on these": for the rest of this visit a
                                      * redirect is followed whether or not it has a
                                      * body — and this one is followed right now,
                                      * since that is what the reader is asking for.
                                      */}
                                    <button
                                        type="button"
                                        className={n.action}
                                        onClick={() => {
                                            setPref('followRedirectsWithBody', true);
                                            followRedirect(pending.to, pending.from);
                                        }}
                                    >
                                        Don&apos;t show again
                                    </button>
                                </p>
                            )}

                            {showRedirected && redirected && (
                                <p role="status" className={n.notice}>
                                    <span className={n.label}>Redirected</span>
                                    <span className={n.muted}>from</span>
                                    <span className={n.url} title={redirected.from}>{redirected.from}</span>
                                    <button
                                        type="button"
                                        className={n.action}
                                        onClick={() => setRedirected(null)}
                                    >
                                        Dismiss
                                    </button>
                                    {/* Hide the "we redirected you" bar for the rest of this visit. Redirects still happen. */}
                                    <button
                                        type="button"
                                        className={n.action}
                                        onClick={() => setPref('hideRedirectedNotice', true)}
                                    >
                                        Don&apos;t show again
                                    </button>
                                </p>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </Window>
    );
}
