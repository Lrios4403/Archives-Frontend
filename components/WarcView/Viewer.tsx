'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Window from "@/components/Window/Window";
import { downloadHref, downloadName, viewHref } from "@/components/WarcSearch/actions";
import { useRecordVisit, useViewHistory } from "./context";
import type { ViewTrailEntry } from "./history";
import s from "@/components/Offline/iframe.module.css";
import n from "@/components/shared/notice.module.css";

/*
 * The chrome is imported from the offline viewer's module on purpose.
 *
 * These two address bars are the same object as far as a reader is concerned —
 * the same back/forward pair, the same url | id | type row, the same Save chip —
 * and the point of this change was that /warcs/view should behave the way
 * /warcs/offline already does. Restating eighty lines of CSS here would have
 * them agree today and drift by the next change.
 */

/**
 * The same rule the offline bar uses: drop the scheme when it is https, keep it
 * when it is not, because "this one was plain http" is worth a reader's notice
 * in an archive and nothing else on the row says it.
 */
const displayUrl = (raw: string): string => {
    try {
        const url = new URL(raw);
        const bare = `${url.host}${url.pathname}${url.search}`;

        if (url.protocol === "https:") return bare.replace(/\/$/, "") || url.host;

        return `${url.protocol}//${bare}`;
    } catch {
        return raw;
    }
};

/** Built once: an Intl formatter per row is measurably worse than reusing one. */
const TRAIL_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

/** A capture's archived date, or "" when the row did not carry one. */
const formatArchived = (raw: string | undefined): string => {
    if (!raw) return "";

    const at = new Date(raw);

    return Number.isNaN(at.getTime()) ? "" : TRAIL_TIME_FORMAT.format(at);
};

/**
 * Where the reader has been, over the top of the page they are on.
 *
 * Newest first, which is the order a Back button implies — the entry you would
 * reach next is the one under the cursor, not the one at the bottom of a list.
 *
 * Absolutely positioned so opening it costs the document no height: a panel in
 * the flow would push the frame down, moving the page under the pointer at the
 * moment the pointer is being used to point at it.
 *
 * The same markup and the same classes as the offline viewer's panel, because it
 * is the same thing — see the note at the top of this file.
 */
const TrailPanel = ({
    entries,
    index,
    onPick,
}: {
    entries: readonly ViewTrailEntry[];
    index: number;
    onPick: (at: number) => void;
}) => (
    // Two elements, not one: the outer is the hoverable bridge across the gap,
    // the inner is the menu. role="menu" belongs on whichever directly contains
    // the menuitems, so it goes on the inner.
    <div className={s.trail}>
        <div role="menu" aria-label="Pages visited" className={s.trailPanel}>
            {/* Indices counted down, so each row still knows its real position. */}
            {Array.from({ length: entries.length }, (_, offset) => entries.length - 1 - offset).map(at => {
                const entry = entries[at]!;
                const current = at === index;

                return (
                    <button
                        key={`${entry.id}:${at}`}
                        type="button"
                        role="menuitem"
                        onClick={() => onPick(at)}
                        aria-current={current ? "page" : undefined}
                        className={`${s.trailRow}${current ? ` ${s.trailRowCurrent}` : ""}`}
                    >
                        <span aria-hidden className={s.trailMarker}>{current ? "▸" : ""}</span>
                        <span className={s.trailUrl} title={entry.url}>
                            {displayUrl(entry.url)}
                        </span>
                        {/*
                          * The same middle column as the header, for the same
                          * reason: a trail through six captures of one page is six
                          * identical rows without it.
                          */}
                        <span className={s.trailId} title={entry.id}>
                            {displayRecordId(entry.id)}
                        </span>
                        <span className={s.trailAt}>{formatArchived(entry.archivedDate)}</span>
                    </button>
                );
            })}
        </div>
    </div>
);

/**
 * The WARC-Record-ID out of a warc_custom_id, which is "file::url::<uuid>".
 *
 * The WHOLE uuid. This sliced to eight characters, and a truncated uuid is not
 * the WARC-Record-ID any more — it is an opaque tag that happens to be unique on
 * this page. It cannot be pasted into a search, matched against a download's
 * manifest, or grepped out of the warc, which is most of what having the id on
 * screen is for.
 *
 * The same call the offline viewer makes (see displayRecordId in
 * Offline/format.ts, and the note on the download filename in downloadButton),
 * and the address grid's 15.5rem id column is already sized for the full 36
 * characters.
 *
 * The full customId — file name included — stays on the title attribute.
 */
const displayRecordId = (id: string): string => id.split("::")[2] || "—";

const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

export interface ViewerRecord {
    id: string;
    url: string;
    contentType?: string | null;
    size?: number | null;
    archivedDate?: string;
    /** HTTP status of the capture. 0 when the row did not carry one. */
    status?: number;
    /**
     * Where this capture points, when it is a 3xx.
     *
     * `id` is null when the destination was never archived — a real answer, and
     * the difference between offering the reader a way onward and offering a
     * control that goes nowhere.
     */
    redirect?: { to: string; id: string | null } | null;
}

const isRedirectStatus = (status: number | undefined): boolean =>
    !!status && status >= 300 && status < 400;

export default function WarcViewer({
    record,
    apiBase,
}: {
    record: ViewerRecord;
    apiBase: string;
}) {
    const router = useRouter();
    const frameRef = useRef<HTMLIFrameElement>(null);

    /*
     * The trail lives in a context now, not in this component and not in a module
     * binding. See history.ts for why — briefly: a module array died on reload,
     * and nothing else on the page could subscribe to it.
     *
     * Recording the visit and reading the trail are two different subscriptions
     * on purpose. `useRecordVisit` takes the stable store and never re-renders
     * this component; `useViewHistory` takes the snapshot and re-renders it on
     * every navigation, which is exactly when the address bar has to change.
     */
    useRecordVisit(record);

    const history = useViewHistory();
    const trail = history?.entries ?? [];
    const canGoBack = history?.canGoBack ?? false;
    const canGoForward = history?.canGoForward ?? false;

    /*
     * Closed on every navigation.
     *
     * Picking a row routes, and the panel is anchored to an address line that is
     * about to say something else — left open it would be a menu describing the
     * page you just left, hanging over the page you just arrived at. Hover alone
     * would not close it either: the pointer never moves, so no mouseleave fires.
     */
    const [trailOpen, setTrailOpen] = useState(false);
    useEffect(() => { setTrailOpen(false); }, [record.id]);

    const go = useCallback((to: ViewTrailEntry | null | undefined) => {
        if (to) router.push(viewHref(to.id));
    }, [router]);

    /*
     * The origin every archived document is served from.
     *
     * Derived from the same apiBase the frame's src is built from, so the check
     * and the thing it is checking cannot drift. Falls back to a value nothing
     * can equal rather than to "*", so a malformed apiBase fails closed.
     */
    const archiveOrigin = useMemo(() => {
        try {
            return new URL(apiBase).origin;
        } catch {
            return "no-archive-origin";
        }
    }, [apiBase]);

    const [resolving, setResolving] = useState<string | null>(null);
    const [missing, setMissing] = useState<string | null>(null);
    const resolvingRef = useRef<string | null>(null);

    /*
     * A url from inside the frame, turned into a capture and routed to.
     *
     * The frame cannot do this itself. It does not know what the archive holds,
     * and being cross-origin it could not ask even if it did — so it reports
     * where the reader tried to go, and this decides what that means.
     */
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const data = event.data;
            if (!data || data.type !== "warc-navigate" || typeof data.url !== "string") return;

            /*
             * From the archive, at any depth.
             *
             * This compared `event.source` against `frameRef.current.contentWindow`,
             * which is only ever the OUTERMOST archived frame — so a click inside
             * a nested one was dropped on the floor. Not a rare shape either: the
             * berry page in 5am.warc builds 18 nested frames, and every link in
             * every one of them was inert.
             *
             * The guard inside the document already walks up past any window that
             * flagged itself archived and posts to the viewer, so the message
             * arrives correctly; it was this end that refused it.
             *
             * Origin, not window identity, because identity cannot answer "is this
             * one of mine" for a frame the parent never created a handle to. Every
             * archived document — nested or not — is served by the backend, so its
             * origin is the one thing that is both knowable from here and true at
             * any depth.
             */
            if (event.origin !== archiveOrigin) return;

            const url = data.url;

            // Already chasing this one. A page that fires both a click handler
            // and a location assignment would otherwise route twice.
            if (resolvingRef.current === url) return;

            resolvingRef.current = url;
            askedRef.current = url;
            setResolving(url);
            setMissing(null);

            const near = new URLSearchParams({ uri: url, redirect: "true" });
            if (typeof data.dateNear === "string" && data.dateNear) near.set("dateNear", data.dateNear);

            // Same-origin: next.config.mjs proxies this to the Bun backend,
            // which sends no CORS headers of its own.
            fetch(`/api/warcs/near?${near}`)
                .then(response => (response.ok ? response.json() : null))
                .then(found => {
                    /*
                     * An ARRAY, not a row.
                     *
                     * The route answers with `Response.json(near)` and `near` is
                     * the raw Bun.sql result, which is a row array even for a
                     * `LIMIT 1` query. Reading `.warc_custom_id` off it gives
                     * undefined, so every navigation reported "not archived" for
                     * pages that were plainly in the archive.
                     *
                     * Both shapes are accepted rather than just the array, so
                     * this keeps working if the route is ever tidied to return
                     * the single row it always has.
                     */
                    const row = Array.isArray(found) ? found[0] : found;
                    const id = row?.warc_custom_id;
                    if (typeof id === "string" && id) router.push(viewHref(id));
                    // Nothing archived there. Said out loud, rather than routing
                    // somewhere arbitrary or appearing to ignore the click.
                    else setMissing(url);
                })
                .catch(() => setMissing(url))
                .finally(() => {
                    resolvingRef.current = null;
                    setResolving(null);
                });
        };

        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [router, archiveOrigin]);

    // A "not archived" notice belongs to the click that produced it, not to the
    // page the reader is now on.
    useEffect(() => { setMissing(null); }, [record.id]);

    const src = useMemo(() => {
        const url = new URL(`${apiBase}/api/warcs/view`);
        url.searchParams.set("id", record.id);
        // The whole reason a click inside the frame reaches this component.
        url.searchParams.set("redirectAction", "postMessage");
        return url.href;
    }, [apiBase, record.id]);

    const size = record.size ? formatBytes(Number(record.size)) : "";

    /*
     * What Save actually saves.
     *
     * A 3xx capture stores a redirect stub and nothing else — measured at 1,206
     * bytes and one file for a real 301 in this archive — so saving the id on
     * screen hands the reader a page that is not the page. When the destination
     * is archived, Save targets THAT: the thing they were looking at when they
     * pressed it, resources and all.
     *
     * A redirect whose destination was never captured falls back to the stub,
     * because a stub is still the honest answer to "save what is here".
     */
    const redirected = isRedirectStatus(record.status);
    const saveId = (redirected && record.redirect?.id) || record.id;
    const savingDestination = saveId !== record.id;

    /*
     * Arriving somewhere other than where the click asked for.
     *
     * `near?redirect=true` follows a 3xx server-side, so a click on a redirecting
     * link lands on the destination and the reader is never told. The url that
     * was asked for is kept here and compared once the record changes — a ref
     * rather than state because it must survive the soft navigation without
     * causing one of its own.
     */
    const askedRef = useRef<string | null>(null);
    const [redirectedFrom, setRedirectedFrom] = useState<string | null>(null);

    useEffect(() => {
        const asked = askedRef.current;
        askedRef.current = null;

        // Compared on the url, not the id: the reader asked for an address.
        setRedirectedFrom(asked && asked !== record.url ? asked : null);
    }, [record.id, record.url]);

    const addressBar = (
        <div className={s.addressRow}>
            <div className={s.navPair}>
                <button
                    type="button"
                    onClick={() => go(history?.back)}
                    disabled={!canGoBack}
                    aria-label="Back"
                    title="Back"
                    className={s.navButton}
                >
                    {"←"}
                </button>
                <button
                    type="button"
                    onClick={() => go(history?.forward)}
                    disabled={!canGoForward}
                    aria-label="Forward"
                    title="Forward"
                    className={s.navButton}
                >
                    {"→"}
                </button>
            </div>

            <div
                className={s.addressWrap}
                onMouseEnter={() => setTrailOpen(true)}
                onMouseLeave={() => setTrailOpen(false)}
                // Hover cannot be the only way in: there is nothing to hover with
                // a keyboard, and a hover-only panel does not exist at all on a
                // touch screen. So the button toggles it too, and Escape closes it
                // — bubbling up from whichever row has focus.
                onKeyDown={event => { if (event.key === "Escape") setTrailOpen(false); }}
            >
                {/*
                  * A button now, and it was a div until there was a trail to show.
                  *
                  * The columns are the same template the history rows use
                  * (.addressGrid), so the url, the id and the type read as columns
                  * across the header and every row rather than as lines that
                  * happen to contain similar things. The empty first cell is the
                  * marker column — it carries no marker here and pays 12px for it
                  * so the header's url starts exactly above the rows'.
                  */}
                <button
                    type="button"
                    onClick={() => setTrailOpen(open => !open)}
                    aria-expanded={trailOpen}
                    aria-haspopup="menu"
                    // Matched to the panel's own condition below. `=== 0` left the
                    // control enabled on a one-entry trail, so it took a click and
                    // opened nothing — a menu offering only the page you are on.
                    disabled={trail.length < 2}
                    title={record.url}
                    className={s.address}
                >
                    <span aria-hidden />
                    <span className={s.addressUrl}>
                        {resolving ? `→ ${displayUrl(resolving)}` : displayUrl(record.url)}
                    </span>
                    <span className={s.addressRecord} title={record.id}>
                        {displayRecordId(record.id)}
                    </span>
                    <span className={s.addressType}>
                        {record.contentType ?? ""}
                        {size && ` | ${size}`}
                    </span>
                </button>

                {/*
                  * Only with somewhere to go. A one-entry panel offering the page
                  * you are already on is a menu that does nothing.
                  */}
                {trailOpen && trail.length > 1 && (
                    <TrailPanel
                        entries={trail}
                        index={history?.index ?? -1}
                        onPick={at => {
                            setTrailOpen(false);
                            go(trail[at]);
                        }}
                    />
                )}
            </div>

            {/*
              * The status, shown only when it is not a plain 2xx.
              *
              * A 200 is the case a reader assumes, so labelling it is noise; a
              * 301, a 404 or a 500 changes what the empty frame below MEANS, and
              * without it an archived redirect and an archived blank page look
              * identical.
              */}
            {record.status !== undefined && record.status > 0 && (record.status < 200 || record.status >= 300) && (
                <span
                    className={s.titleChip}
                    title={redirected && record.redirect
                        ? `${record.status} redirect to ${record.redirect.to}`
                        : `HTTP ${record.status}`}
                >
                    {record.status}
                    {redirected && " →"}
                </span>
            )}

            {/*
              * Saves the page ON SCREEN, so it sits beside the address naming it.
              * A plain link, like the record listing's: the response carries
              * Content-Disposition, so a navigation saves the file.
              */}
            <a
                href={downloadHref(saveId)}
                download={downloadName(saveId)}
                className={s.titleChip}
                title={savingDestination
                    ? `This capture is a ${record.status} redirect, which stores no page. Saves the destination instead, with the resources it references.`
                    : "Download this capture, with the resources it references"}
            >
                {"⤓ Save"}
            </a>
        </div>
    );

    return (
        <Window
            title={record.url || "Archived Site"}
            titleContent={addressBar}
            // The bar carries real controls now, so three fake ones beside a
            // working Save button would invite the reader to try them.
            controls={false}
            flush
        >
            <div className={s.frame}>
                <iframe
                    ref={frameRef}
                    className={s.document}
                    src={src}
                    title={`Archived: ${record.url}`}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                />

                {/*
                  * One stack, pinned over the bottom of the frame. Absolute, so a
                  * notice appearing never shoves the page the reader is reading.
                  */}
                {(missing || (redirected && record.redirect) || redirectedFrom) && (
                    <div className={n.notices}>
                        {missing && (
                            <p role="status" className={`${n.notice} ${n.noticeMissing}`}>
                                <span className={n.label}>Not archived</span>
                                <span className={n.url} title={missing}>{missing}</span>
                            </p>
                        )}

                        {/*
                          * Landed on a redirect. The frame behind this is showing
                          * the stub's empty body, which on its own looks like a
                          * page that failed to load rather than one never here.
                          */}
                        {redirected && record.redirect && (
                            <p
                                role="status"
                                className={`${n.notice}${record.redirect.id ? "" : ` ${n.noticeMissing}`}`}
                            >
                                <span className={n.label}>{record.status} redirect</span>
                                <span className={n.muted} aria-hidden>→</span>
                                <span className={n.url} title={record.redirect.to}>
                                    {record.redirect.to}
                                </span>
                                {record.redirect.id ? (
                                    <button
                                        type="button"
                                        className={n.action}
                                        onClick={() => go({ id: record.redirect!.id!, url: record.redirect!.to })}
                                    >
                                        Follow →
                                    </button>
                                ) : (
                                    <span className={n.muted}>not archived</span>
                                )}
                            </p>
                        )}

                        {/*
                          * Arrived somewhere else. The lookup follows a 3xx for
                          * us, which is right and silent about itself — so the
                          * reader asks for one address and gets another with no
                          * explanation.
                          */}
                        {redirectedFrom && (
                            <p role="status" className={n.notice}>
                                <span className={n.label}>Redirected</span>
                                <span className={n.muted}>from</span>
                                <span className={n.url} title={redirectedFrom}>{redirectedFrom}</span>
                                <button
                                    type="button"
                                    className={n.action}
                                    onClick={() => setRedirectedFrom(null)}
                                >
                                    Dismiss
                                </button>
                            </p>
                        )}
                    </div>
                )}
            </div>
        </Window>
    );
}
