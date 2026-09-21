'use client';

import { useEffect, useMemo, useRef } from "react";
import type { WarcRecord as TimelineRecord } from "@/lib/db";
import TimelineWidget from "@/components/WarcSearch/TimelineWidget";
import { formatBytes, payloadSize } from "./format";
import { WarcRecord, WarcRecordTreeNode } from "./types";
import shared from "./Offline.module.css";
import s from "./recordListingTimeline.module.css";

/**
 * The offline viewer's take on the search page's timeline.
 *
 * Same TimelineWidget, different records and different actions. The two record
 * shapes are genuinely different things: lib/db's WarcRecord is a row that came
 * back from Postgres with ISO date strings and a flat status, while this
 * WarcRecord was parsed out of a File in the browser two seconds ago and holds
 * Dates, a nested http block and a byte range. Rather than widen the widget to
 * accept both — which would leave every field optional and every call site
 * guessing — this adapts one into the other at the boundary.
 */

/** Actions a caller supplies. Both optional: unwired is shown as unwired. */
export interface WarcOfflineRecordActions {
    /**
     * Open a capture. Not defaulted, because there is nothing sensible to
     * default TO — the record is a byte range in a local File, so viewing it
     * means slicing that range out and building a blob URL, which is a decision
     * about payload handling rather than about this component.
     */
    onView?: (record: WarcRecord) => void;

    /** Save a capture's payload. Same reasoning. */
    onDownload?: (record: WarcRecord) => void;
}

/**
 * Adapt a parsed record to the shape TimelineWidget reads.
 *
 * `recordId` is customId rather than uuid: uuid repeats across files (a derived
 * WARC keeps the original record ids), and this panel can show records from
 * several loaded files at once, so uuid is not unique here.
 *
 * `size` prefers the DE-CHUNKED length. payload.size is the encoded length,
 * which for a chunked body includes the chunk-size lines — reporting that as the
 * response size overstates it, and it is the number you slice with, not the
 * number a reader wants to see.
 */
export const toTimelineRecord = (record: WarcRecord): TimelineRecord => ({
    recordId: record.customId,
    warcRecordId: record.uuid,
    // Falls back to the capture date rather than to an empty string: the widget
    // and the row both put this through new Date(), and new Date('') is Invalid
    // Date, which renders as "Invalid Date" instead of as "unknown".
    lastModified: (record.http?.lastModified ?? record.dateArchived).toISOString(),
    dateArchived: record.dateArchived.toISOString(),
    // 0 for a record with no HTTP status at all, which the row renders as "—".
    status: record.http?.status ?? 0,
    size: record.payload?.fullSize ?? record.payload?.size ?? record.length,
});

/**
 * Responses only, oldest capture first — so the LATEST is at the bottom.
 *
 * Chronological downward, matching the chart directly above it: the bars run
 * oldest-to-newest left to right, so a list running newest-to-oldest downward
 * read backwards against them. Reading order is now the same in both.
 *
 * Ties break on byte offset, which is file order. Two captures can share a
 * timestamp to the second, and without a second key their order would depend on
 * which one the parser happened to hand over first.
 *
 * `filter` already returns a new array, so the caller's `node.records` is never
 * reordered by the sort — there is no defensive copy here because there does not
 * need to be one.
 */
export const timelineResponses = (records: WarcRecord[]): WarcRecord[] =>
    records
        .filter(record => record.type === 'response')
        .sort((a, b) =>
            a.dateArchived.getTime() - b.dateArchived.getTime() ||
            a.offset - b.offset);


// Both built once, for the reason given on COUNT_FORMAT in fileListing: passing
// options to toLocaleString compiles a formatter per call, and these run per row.
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const NUMBER_FORMAT = new Intl.NumberFormat();

const formatDateTime = (date: Date): string => DATE_TIME_FORMAT.format(date);

/**
 * The status band, as one class rather than a pair of Tailwind colour utilities.
 *
 * The bands are unchanged. What changed is where the colours come from: these
 * are the same --status-* / --error-* tokens WarcSearch/WarcRecordItem uses, so
 * a 404 looks the same in the offline viewer as it does on the search page
 * instead of being a second opinion about what red means.
 */
const statusClass = (status: number | null): string => {
    if (status === null || status === 0) return s.statusNone;
    if (status < 300) return s.statusOk;
    if (status < 400) return s.statusRedirect;
    if (status < 500) return s.statusClient;
    return s.statusServer;
};

function WarcOfflineResponseRow({
    record,
    active,
    onView,
    onDownload,
}: { record: WarcRecord; active?: boolean } & WarcOfflineRecordActions) {
    const status = record.http?.status ?? null;
    const chunked = Boolean(record.payload?.chunks?.length);

    return (
        <li
            // The capture on screen, when this list is showing beside a viewer.
            // A left rule rather than a background: the rows already use colour
            // for status, and a second colour would compete with it.
            aria-current={active ? 'true' : undefined}
            className={`${s.row}${active ? ` ${s.rowActive}` : ''}`}
        >
            <div className={s.rowHead}>
                <span className={`${s.status} ${statusClass(status)}`}>
                    {status === null || status === 0 ? '—' : status}
                </span>
                <time className={s.time} dateTime={record.dateArchived.toISOString()}>
                    {formatDateTime(record.dateArchived)}
                </time>
                {record.contentType && (
                    <span className={s.contentType}>{record.contentType}</span>
                )}
                {record.truncated && (
                    <span
                        className={s.truncatedBadge}
                        title={`The crawler stored a partial body (${record.truncated})`}
                    >
                        truncated: {record.truncated}
                    </span>
                )}
            </div>

            <dl className={s.facts}>
                <div className={s.fact}>
                    <dt>Size</dt>
                    <dd title={record.payload ? `${record.payload.size} bytes on disk` : undefined}>
                        {formatBytes(payloadSize(record.payload) ?? record.length)}
                        {chunked && <span className={s.chunked}>chunked</span>}
                    </dd>
                </div>
                <div className={s.fact}>
                    <dt>Offset</dt>
                    <dd className={shared.mono}>{NUMBER_FORMAT.format(record.offset)}</dd>
                </div>
                <div className={s.factWide}>
                    <dt>File</dt>
                    <dd className={shared.truncate} title={record.fileHandle.name}>{record.fileHandle.name}</dd>
                </div>
            </dl>

            {/*
              * The WARC-Record-ID in full, on its own line.
              *
              * It was showing the first 8 characters of the uuid, which is not an
              * identifier — it matches nothing in the file, cannot be pasted into a
              * search, and two records whose ids share a prefix look identical. A
              * uuid is 36 characters and does not fit in a quarter of the row, so it
              * gets the full width rather than being cut down to fit.
              */}
            <dl className={s.idRow}>
                <dt>WARC-Record-ID</dt>
                <dd className={s.idValue} title={record.uuid}>{record.uuid}</dd>
            </dl>

            <div className={s.actions}>
                {/*
                  * Disabled rather than hidden when unwired, and disabled rather
                  * than a dead href. A button that navigates nowhere reads as a
                  * bug; a disabled one with a reason reads as "not yet".
                  */}
                <button
                    type="button"
                    disabled={!onView}
                    onClick={() => onView?.(record)}
                    title={onView ? undefined : 'Viewing a local capture is not wired up yet'}
                    className={shared.chipButton}
                >
                    🔍 View
                </button>
                <button
                    type="button"
                    disabled={!onDownload}
                    onClick={() => onDownload?.(record)}
                    title={onDownload ? undefined : 'Downloading a local capture is not wired up yet'}
                    className={shared.chipButton}
                >
                    📥 Download
                </button>
            </div>
        </li>
    );
}

/**
 * The chart and the list of captures — everything inside the panel except the
 * panel.
 *
 * Extracted so the tree's overlay and the viewer's own capture panel are the
 * SAME component rather than two that look alike. They differ only in what wraps
 * them: the tree's floats over its rows and needs a Close, the viewer's sits in
 * the page. A second copy of the row rendering would have drifted the first time
 * either one gained a column.
 */
export function WarcOfflineCaptureList({
    records,
    title,
    activeRecordId,
    anchor,
    onView,
    onDownload,
}: {
    records: WarcRecord[];
    title?: string;
    /** Marks which capture is currently on screen, when one is. */
    activeRecordId?: string;
    /** Where the widget's hrefs point. Meaningful for the status bar; clicks are handled. */
    anchor: string;
} & WarcOfflineRecordActions) {
    // customId -> record, so the timeline's callbacks can hand back the original
    // parsed record rather than the flattened row it was given.
    const byId = useMemo(
        () => new Map(records.map(record => [record.customId, record])),
        [records],
    );

    /**
     * The flattened rows, built once per record list.
     *
     * TimelineWidget does `useMemo(() => groupRecords(records), [records])`, and
     * a fresh array here every render meant that memo never hit — the whole
     * grouping pass re-ran on every render. Which, through the viewer's capture
     * panel, is every animation frame for the duration of a parse.
     */
    const rows = useMemo(() => records.map(toTimelineRecord), [records]);


    return (
        <>
            {records.length > 0 && (
                <div className={s.chart}>
                    <TimelineWidget
                        records={rows}
                        title={title ?? 'Captures'}
                        activeRecordId={activeRecordId}
                        // Both overridden, because both defaults assume a
                        // database row: /warcs/view?id= would 404 on a customId,
                        // and there is no #record-… element on this page to
                        // scroll to. The href is kept meaningful for middle-click
                        // and for the status bar even though the click is handled.
                        viewHref={() => `#${encodeURIComponent(anchor)}`}
                        // A bar stands for a day, and the widget hands back the
                        // first record of that day's group. Since the list is
                        // chronological, that is the day's EARLIEST capture —
                        // stated here because it is a consequence of the sort
                        // order rather than a choice made at this call site.
                        onSelect={(row) => {
                            const record = byId.get(row.recordId);
                            if (record) onView?.(record);
                        }}
                        onDownload={onDownload
                            ? (rows) => {
                                rows.forEach(row => {
                                    const record = byId.get(row.recordId);
                                    if (record) onDownload(record);
                                });
                            }
                            : undefined}
                    />
                </div>
            )}

            <ul className={s.list}>
                {records.length === 0
                    ? <li className={s.empty}>
                        No responses here. This url was seen in the archive, but only as a
                        request or a redirect target — nothing with a body was stored for it.
                    </li>
                    : records.map(record => (
                        <WarcOfflineResponseRow
                            key={record.customId}
                            record={record}
                            active={record.customId === activeRecordId}
                            onView={onView}
                            onDownload={onDownload}
                        />
                    ))}
            </ul>
        </>
    );
}

export default function WarcOfflineRecordListingTimeline({
    node,
    onClose,
    onView,
    onDownload,
}: {
    node: WarcRecordTreeNode;
    onClose: () => void;
    } & WarcOfflineRecordActions) {
    const closeRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Focus lands on Close so the panel is dismissable from the keyboard the
        // moment it opens — it covers the rows underneath, so leaving focus back
        // on the badge would mean tabbing through content hidden behind the
        // overlay.
        //
        // preventScroll, because focusing an element inside a scroll container
        // scrolls it into view — and that would put the CLOSE BUTTON on screen,
        // which is the top edge of the panel. Then the deliberate scroll below
        // brings as much of the whole panel into view as will fit. Two competing
        // scrolls otherwise, and the second one wins by accident.
        closeRef.current?.focus({ preventScroll: true });

        // `nearest`, so a panel already fully visible does not move the pane at
        // all. Opening one on the last row used to leave it clipped by the
        // bottom of the scroll pane with no hint that there was more.
        panelRef.current?.scrollIntoView({ block: 'nearest' });
    }, []);

    /*
     * Memoised on the node's records, not recomputed per render.
     *
     * This panel lives on a tree row, and that row re-renders whenever its node
     * version bumps — up to sixty times a second while a parse is running. A fresh
     * array here invalidated everything downstream that keys off it: the `byId` map,
     * the `rows` list, and TimelineWidget's own `useMemo(() => groupRecords(records))`,
     * which re-derives with a `new Date` per record. The note beside `byId` describes
     * exactly that failure — the fix landed in the child and the parent kept handing
     * it a new array.
     *
     * `[node.records, node.records.length]` is the right dependency pair for an array
     * MUTATED IN PLACE: identity alone never changes, so it would never recompute;
     * length alone would miss a swap. The same pair viewTimeline.tsx already uses.
     */
    const responses = useMemo(
        () => timelineResponses(node.records),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [node.records, node.records.length],
    );

    return (
        <div
            ref={panelRef}
            className={s.overlay}
            role="dialog"
            aria-label={`Responses archived at ${node.url}`}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    onClose();
                }
            }}
        >
            <div className={s.overlayHead}>
                <div className={shared.spacer}>
                    <p className={shared.urlLine} title={node.url}>{node.url}</p>
                    <p className={shared.meta}>
                        {responses.length} response{responses.length === 1 ? '' : 's'}
                    </p>
                </div>
                <button
                    ref={closeRef}
                    type="button"
                    onClick={onClose}
                    aria-label={`Close responses for ${node.url}`}
                    className={shared.chipButton}
                >
                    ✕ Close
                </button>
            </div>

            <WarcOfflineCaptureList
                records={responses}
                anchor={node.url}
                onView={onView}
                onDownload={onDownload}
            />
        </div>
    );
}
