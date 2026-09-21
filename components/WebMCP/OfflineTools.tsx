"use client"

/*
 * WebMCP tools for the offline viewer.
 *
 * Mounted INSIDE OfflineContextProvider, because everything here operates on the
 * archive the reader has loaded into this tab. Nothing in this file talks to the
 * network — the record index, the search index and the page rebuilder are all in
 * memory, put there by the parse workers.
 *
 * ## The division of labour, and why it is not a limitation
 *
 * A person loads the archive; an agent navigates it.
 *
 * That split is forced: the entry point is <input type="file">, and no agent can
 * populate a file picker — a browser will not let script choose a file on
 * someone's disk, and nor should it. So there is no load_archive tool here and
 * there cannot be one.
 *
 * What is left is the half that actually needs help. Once a WARC is parsed, this
 * page is a custom tree widget, an iframe and a postMessage channel — a
 * "human-first interface" in the WebMCP docs' phrase, and one that DOM scraping
 * cannot drive. Finding the 2018 capture of a page inside a 3 GB archive is a
 * few map lookups for these tools and essentially impossible by clicking.
 *
 * ## Parsing happens in workers, and these tools do not wait for it
 *
 * parseFileHandles() hands files to a worker pool and returns synchronously.
 * start_parsing therefore reports that work has BEGUN and returns; it never
 * blocks an agent for the minutes a multi-gigabyte parse takes. Progress is a
 * separate read (list_loaded_archives), which is also how the UI does it —
 * the store flushes once per animation frame while a parse runs.
 *
 * ## Search uses the archive's own index
 *
 * Not a scan. recordEntries.segments maps each distinct path segment to the
 * nodes carrying it, precisely so that finding "garden" does not mean visiting
 * all 1,806 nodes of a small archive, let alone a large one. These tools use the
 * same index the search box does.
 */

import { useContext, useEffect, useRef } from "react"
import { WarcFilesContext, WarcRecordContext, WarcViewContext } from "@/components/Offline/context"
import { findNearestRecord } from "@/components/Offline/view"
import { usefulWorkers } from "@/components/Offline/workers"
import type {
    WarcFilesState,
    WarcRecord,
    WarcRecordContextType,
    WarcRecordTreeNode,
    WarcViewState,
} from "@/components/Offline/types"

/** Rows any one tool will list. Output is read by a model, so length is a cost. */
const MAX_ROWS = 25

const day = (d: Date | string | null | undefined): string => {
    if (!d) return "unknown date"

    const iso = d instanceof Date ? d.toISOString() : String(d)

    return iso.slice(0, 10)
}

const truncated = (shown: number, total: number): string =>
    total > shown ? `\n(${shown} of ${total} shown)` : ""

/** Responses only. A WARC pairs a request with every response, and revisits pile on top. */
const isBrowsable = (r: WarcRecord): boolean => r.type === "response" && Boolean(r.url)

export default function OfflineTools() {
    const records = useContext(WarcRecordContext)
    const view = useContext(WarcViewContext)
    const files = useContext(WarcFilesContext)

    /*
     * Registration happens once, on mount. Execution happens much later, against
     * whatever is loaded THEN — so the contexts are read through refs rather than
     * captured in the closure.
     *
     * WarcRecordContext's identity never changes by design, so it alone would be
     * safe to close over. WarcViewContext and WarcFilesContext change on every
     * navigation and every file added, and a tool holding the mount-time value of
     * those would answer questions about an archive the reader had already
     * replaced.
     */
    const recordsRef = useRef<WarcRecordContextType | undefined>(records)
    const viewRef = useRef<WarcViewState | undefined>(view)
    const filesRef = useRef<WarcFilesState | undefined>(files)

    recordsRef.current = records
    viewRef.current = view
    filesRef.current = files

    useEffect(() => {
        const modelContext = document.modelContext

        if (!modelContext) return

        const controller = new AbortController()

        /** Nothing is loaded until a person has loaded it — say so, the same way, everywhere. */
        const needArchive =
            "No archive is loaded in this tab yet. The reader has to choose local .warc, .warc.gz or " +
            ".wacz files with the file picker on this page first — a file cannot be opened from here, " +
            "by design. Once files are chosen, call start_parsing."

        const entriesOrNull = () => {
            const ctx = recordsRef.current

            return ctx && ctx.recordEntries.recordCount > 0 ? ctx : null
        }

        const tools: WebMCP.ModelContextTool[] = [
            /* ---------------------------------------------------------------
             * What is loaded
             * ------------------------------------------------------------ */
            {
                name: "list_loaded_archives",
                title: "Archives loaded in this tab",
                description:
                    "The WARC files the reader has loaded here, with each file's parse status and how " +
                    "many records it has produced so far. Also the right way to check on a parse — " +
                    "start_parsing returns immediately and the work continues in background workers.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
                execute: () => {
                    const handles = filesRef.current?.fileHandles ?? []
                    const ctx = recordsRef.current

                    if (!handles.length) return needArchive

                    const lines = handles.slice(0, MAX_ROWS).map((h) => {
                        const pct =
                            h.size && h.parsedOffset
                                ? ` ${Math.min(100, Math.round((h.parsedOffset / h.size) * 100))}%`
                                : ""

                        return (
                            `${h.name}  ${h.status ?? "pending"}${pct}` +
                            (h.records ? `  ${h.records.toLocaleString()} records` : "") +
                            (h.error ? `  ERROR: ${h.error.message}` : "")
                        )
                    })

                    return (
                        `${handles.length} file${handles.length === 1 ? "" : "s"} loaded.\n` +
                        `${(ctx?.recordEntries.recordCount ?? 0).toLocaleString()} records parsed so far, ` +
                        `${(ctx?.recordEntries.responseCount ?? 0).toLocaleString()} of them responses.\n\n` +
                        lines.join("\n") +
                        truncated(lines.length, handles.length)
                    )
                },
            },
            {
                name: "describe_loaded_archive",
                title: "What is in the loaded archive",
                description:
                    "A summary of the parsed archive: how many captures, which hosts they belong to, " +
                    "and the span of dates covered. Use this first to orient before searching.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: () => {
                    const ctx = entriesOrNull()

                    if (!ctx) return needArchive

                    const entries = ctx.recordEntries
                    const hosts = new Map<string, number>()
                    let earliest: Date | null = null
                    let latest: Date | null = null

                    entries.records.forEach((r) => {
                        if (!isBrowsable(r)) return

                        try {
                            const host = new URL(r.url).host

                            hosts.set(host, (hosts.get(host) ?? 0) + 1)
                        } catch {
                            // Not a parseable url — onion: and i2p: land here. Not a host, not counted.
                        }

                        const d = r.dateArchived

                        if (d instanceof Date && !Number.isNaN(d.getTime())) {
                            if (!earliest || d < earliest) earliest = d
                            if (!latest || d > latest) latest = d
                        }
                    })

                    const top = [...hosts.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 12)
                        .map(([h, n]) => `  ${h}  ${n.toLocaleString()}`)

                    return (
                        `${entries.responseCount.toLocaleString()} browsable captures ` +
                        `(${entries.recordCount.toLocaleString()} records in total, the rest being requests, ` +
                        `revisits and file metadata).\n` +
                        `Dates: ${day(earliest)} to ${day(latest)}.\n` +
                        `${hosts.size} host${hosts.size === 1 ? "" : "s"}, the largest:\n${top.join("\n")}`
                    )
                },
            },

            /* ---------------------------------------------------------------
             * Finding things, through the in-memory index
             * ------------------------------------------------------------ */
            {
                name: "search_loaded_records",
                title: "Search the loaded archive",
                description:
                    "Finds captures in the loaded archive whose URL contains the query. Searches the " +
                    "archive's own index rather than the page, so it sees everything parsed, including " +
                    "captures not currently visible in the tree. Optionally filter by content type.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: 'Text to find in the URL, for example "garden" or "index.html".',
                        },
                        contentType: {
                            type: "string",
                            description: 'Optional exact base type, for example "text/html" or "image/png".',
                        },
                        limit: { type: "number", description: `Results to return, 1-${MAX_ROWS}.` },
                    },
                    required: ["query"],
                },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: ({ query, contentType, limit }) => {
                    const ctx = entriesOrNull()

                    if (!ctx) return needArchive

                    const entries = ctx.recordEntries
                    const needle = String(query ?? "").toLowerCase()
                    const cap = Math.min(Math.max(1, Number(limit) || MAX_ROWS), MAX_ROWS)

                    if (!needle) return "Give something to search for."

                    /*
                     * The segment index, not a walk of the tree. `segments` maps each
                     * DISTINCT path segment to the nodes carrying it, which is what
                     * makes this cost one pass over the names rather than one pass
                     * over every node for every keystroke.
                     */
                    const hits = new Set<WarcRecordTreeNode>()

                    entries.segments.forEach((nodes, segment) => {
                        if (segment.toLowerCase().includes(needle)) nodes.forEach((n) => hits.add(n))
                    })

                    // A query like "example.com/about" names no single segment, so fall
                    // back to matching whole urls before reporting nothing.
                    if (hits.size === 0) {
                        entries.recordsUrlMap.forEach((recs, url) => {
                            if (url.toLowerCase().includes(needle)) {
                                const node = entries.recordTreeIndex.get(url)

                                if (node) hits.add(node)
                            }
                        })
                    }

                    const wanted = contentType ? String(contentType).toLowerCase() : null

                    const rows = [...hits]
                        .flatMap((node) => node.records.filter(isBrowsable))
                        .filter((r) => !wanted || r.contentType === wanted)

                    if (!rows.length) {
                        return (
                            `Nothing in the loaded archive matches ${JSON.stringify(query)}` +
                            (contentType ? ` with content type ${contentType}` : "") +
                            ". Try describe_loaded_archive to see which hosts are present."
                        )
                    }

                    // Newest capture of each url first; one line per url, not per capture.
                    const byUrl = new Map<string, WarcRecord[]>()

                    rows.forEach((r) => byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r]))

                    const lines = [...byUrl.entries()].slice(0, cap).map(([url, recs]) => {
                        const newest = recs.reduce((a, b) => (a.dateArchived > b.dateArchived ? a : b))

                        return (
                            `${url}\n    ${recs.length} capture${recs.length === 1 ? "" : "s"}, ` +
                            `latest ${day(newest.dateArchived)}, ${newest.contentType || "unknown type"}`
                        )
                    })

                    return (
                        `${byUrl.size} matching URL${byUrl.size === 1 ? "" : "s"} in the loaded archive:\n\n` +
                        lines.join("\n") +
                        truncated(lines.length, byUrl.size)
                    )
                },
            },
            {
                name: "get_loaded_timeline",
                title: "Every capture of one URL in the loaded archive",
                description:
                    "All captures of one exact URL held in the loaded archive, newest first. " +
                    "Use search_loaded_records first if you do not have the exact URL.",
                inputSchema: {
                    type: "object",
                    properties: { url: { type: "string", description: "The exact URL, including scheme." } },
                    required: ["url"],
                },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: ({ url }) => {
                    const ctx = entriesOrNull()

                    if (!ctx) return needArchive

                    const recs = (ctx.recordEntries.recordsUrlMap.get(String(url)) ?? []).filter(isBrowsable)

                    if (!recs.length) {
                        return `No captures of ${url} in the loaded archive. Scheme matters — try the other of http:// and https://, or search_loaded_records.`
                    }

                    const sorted = [...recs].sort(
                        (a, b) => b.dateArchived.getTime() - a.dateArchived.getTime(),
                    )

                    return (
                        `${recs.length} capture${recs.length === 1 ? "" : "s"} of ${url}:\n\n` +
                        sorted
                            .slice(0, MAX_ROWS)
                            .map(
                                (r) =>
                                    `${day(r.dateArchived)}  ${r.contentType || "unknown type"}  ` +
                                    `${r.fileHandle?.name ?? "unknown file"}  id=${r.customId}`,
                            )
                            .join("\n") +
                        truncated(Math.min(sorted.length, MAX_ROWS), recs.length)
                    )
                },
            },
            {
                name: "find_loaded_capture_as_of",
                title: "The loaded capture closest to a date",
                description:
                    "Finds the capture of a URL nearest a given date within the loaded archive, following " +
                    "any archived redirects on the way. Reports which capture it settled on and the " +
                    "redirects it walked. Does not display it — use open_loaded_capture for that.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The URL to look up, including scheme." },
                        date: {
                            type: "string",
                            description: 'Target date as YYYY-MM-DD. Omit for the most recent capture.',
                        },
                    },
                    required: ["url"],
                },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: ({ url, date }) => {
                    const ctx = entriesOrNull()

                    if (!ctx) return needArchive

                    const near = date ? new Date(String(date)).toISOString() : new Date().toISOString()
                    const result = findNearestRecord(ctx.recordEntries, String(url), near, {
                        // A top-level navigation stops at a redirect that has a body
                        // rather than following it, which is what the reader sees too.
                        stopAtBodiedRedirect: true,
                    })

                    if (!result.record) {
                        return `Nothing in the loaded archive for ${url}${date ? ` near ${date}` : ""} (${result.reason ?? "not found"}). Try get_loaded_timeline or search_loaded_records.`
                    }

                    return (
                        `Closest capture of ${url}${date ? ` to ${date}` : ""}:\n` +
                        `  archived ${day(result.record.dateArchived)}\n` +
                        `  ${result.record.contentType || "unknown type"}\n` +
                        `  id=${result.record.customId}\n` +
                        (result.redirects.length
                            ? `  followed ${result.redirects.length} redirect(s): ${result.redirects.join(" -> ")}\n`
                            : "") +
                        (result.redirectsTo ? `  this capture redirects to ${result.redirectsTo}\n` : "")
                    )
                },
            },

            /* ---------------------------------------------------------------
             * Acting on the viewer
             * ------------------------------------------------------------ */
            {
                name: "open_loaded_capture",
                title: "Show a loaded capture in the viewer",
                description:
                    "Rebuilds a capture from the loaded archive and shows it in the viewer frame, with its " +
                    "images and stylesheets resolved from the archive. Give a URL, and optionally a date to " +
                    "pick which capture. Changes what is on screen; nothing is downloaded or modified.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The URL to show, including scheme." },
                        date: { type: "string", description: "Optional YYYY-MM-DD to choose a capture." },
                    },
                    required: ["url"],
                },
                annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: true },
                execute: ({ url, date }) => {
                    const ctx = entriesOrNull()

                    if (!ctx) return needArchive
                    if (!ctx.viewArchivedRecord || !ctx.showBlob) return "The viewer is not ready yet."

                    const near = date ? new Date(String(date)).toISOString() : new Date().toISOString()
                    const found = findNearestRecord(ctx.recordEntries, String(url), near, {
                        stopAtBodiedRedirect: true,
                    })

                    if (!found.record) {
                        return `Nothing in the loaded archive for ${url} (${found.reason ?? "not found"}), so there is nothing to show.`
                    }

                    const record = found.record

                    /*
                     * The same path the tree row takes — build, then hand the WHOLE
                     * outcome to showBlob or showViewFailure. Reporting cannot be
                     * skipped: a page that rendered with three images missing is a
                     * different answer from one that rendered, and the notices badge
                     * is where that difference is recorded.
                     */
                    return ctx
                        .viewArchivedRecord(record, ctx.recordEntries)
                        .then((outcome) => {
                            if (outcome.ok) {
                                ctx.showBlob?.(outcome)

                                return (
                                    `Showing the ${day(record.dateArchived)} capture of ${record.url}.` +
                                    (found.redirectsTo
                                        ? ` It is a redirect to ${found.redirectsTo}, shown rather than followed.`
                                        : "")
                                )
                            }

                            ctx.showViewFailure?.(outcome)

                            return `That capture could not be rebuilt: ${outcome.reason}. It is in the archive but not displayable.`
                        })
                        .catch((error) => `Could not open that capture: ${error?.message ?? error}`)
                },
            },
            {
                name: "navigate_viewer_history",
                title: "Step back or forward in the viewer",
                description:
                    "Moves through the pages visited in the viewer this session, the same as the frame's " +
                    "own arrows and the browser's Back button.",
                inputSchema: {
                    type: "object",
                    properties: {
                        direction: { type: "string", enum: ["back", "forward"] },
                    },
                    required: ["direction"],
                },
                annotations: { readOnlyHint: false, consequentialHint: false },
                execute: ({ direction }) => {
                    const ctx = recordsRef.current
                    const v = viewRef.current

                    if (!ctx || !v) return "The viewer is not ready yet."

                    if (direction === "forward") {
                        if (!v.canGoForward) return "There is nothing forward of the current page."

                        ctx.goForward?.()

                        return "Moved forward one page in the viewer."
                    }

                    if (!v.canGoBack) return "There is nothing behind the current page."

                    ctx.goBack?.()

                    return "Moved back one page in the viewer."
                },
            },
            {
                name: "describe_viewer_state",
                title: "What the viewer is showing",
                description:
                    "What is currently in the viewer frame, and how far back the session's trail goes. " +
                    "Use to orient before navigating.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: () => {
                    const v = viewRef.current

                    if (!v) return "The viewer is not ready yet."
                    if (!v.viewingRecord) return "The viewer is empty — no capture has been opened yet."

                    return (
                        `Showing: ${v.viewingRecord.url}\n` +
                        `  archived ${day(v.viewingRecord.dateArchived)}\n` +
                        (v.viewingRedirectsTo ? `  this is a redirect to ${v.viewingRedirectsTo}\n` : "") +
                        (v.viewFailure ? `  the last attempt failed: ${v.viewFailure.reason}\n` : "") +
                        `  position ${v.viewIndex + 1} of ${v.viewTrail.length} in this session's trail\n` +
                        `  can go back: ${v.canGoBack}, forward: ${v.canGoForward}`
                    )
                },
            },

            /* ---------------------------------------------------------------
             * Parsing. Starts workers and returns — never waits.
             * ------------------------------------------------------------ */
            {
                name: "start_parsing",
                title: "Start parsing the chosen files",
                description:
                    "Begins parsing the WARC files the reader has chosen, in background workers. " +
                    "RETURNS IMMEDIATELY — a multi-gigabyte archive takes minutes, and this does not wait " +
                    "for it. Poll list_loaded_archives for progress, and search once records start arriving; " +
                    "the index is usable while the parse is still running.",
                inputSchema: {
                    type: "object",
                    properties: {
                        workers: {
                            type: "number",
                            description:
                                "How many parse workers to use. Omit to let the page decide from the " +
                                "file count and sizes, which is almost always right.",
                        },
                    },
                },
                annotations: { readOnlyHint: false, consequentialHint: false },
                execute: ({ workers }) => {
                    const ctx = recordsRef.current
                    const handles = filesRef.current?.fileHandles ?? []

                    if (!handles.length) return needArchive
                    if (!ctx?.parseFileHandles) return "The parser is not ready yet."

                    /*
                     * usefulWorkers, not the number asked for. A worker takes a WHOLE
                     * file and holds it to the end, so workers beyond what the file
                     * set can occupy just cost a heap and a bundle each — measured on
                     * this page as three of four workers idling from 7s onward.
                     */
                    const requested = Number(workers) || handles.length
                    const useful = usefulWorkers(handles, Math.max(1, Math.min(requested, 16)))

                    ctx.parseFileHandles(useful, handles, ctx.recordEntries)

                    return (
                        `Parsing started: ${useful} worker${useful === 1 ? "" : "s"} across ` +
                        `${handles.length} file${handles.length === 1 ? "" : "s"}. ` +
                        `This continues in the background — call list_loaded_archives to see progress. ` +
                        `Records become searchable as they arrive, so you do not have to wait for it to finish.`
                    )
                },
            },
        ]

        tools.forEach((tool) => {
            modelContext
                .registerTool(tool, { signal: controller.signal })
                .catch((error) => console.warn(`webmcp: could not register ${tool.name}:`, error))
        })

        return () => controller.abort()
        // Registered once. Live state is read through the refs above, not captured here.
    }, [])

    return null
}
