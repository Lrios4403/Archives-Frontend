"use client"

/*
 * WebMCP tools for the archive.
 *
 * WebMCP lets a page DECLARE what it can do instead of making an in-browser
 * agent infer it from the DOM. Registered here, in one client component mounted
 * from the root layout, so an agent that lands on any page of the site has the
 * whole toolset.
 *
 * ## Why this is worth doing for an archive specifically
 *
 * The backend can answer questions the UI has no controls for. The clearest is
 * time: /api/warcs/near takes a `dateNear` and returns the capture closest to
 * it — measured against http://kiwifarms.net/, 2017-01-01 resolves to the
 * 2017-07-20 capture, 2018-08-01 to 2018-07-13, 2021-07-01 to 2021-07-09. There
 * is no as-of-date box anywhere on this site. An agent scraping the page cannot
 * express "what did this look like in 2018" at all, however clever it is; a
 * tool expresses it in one call.
 *
 * The same holds for the redirect chain (/api/warcs/path returns one row per
 * hop with its Location and where it resolved) and for the capture timeline
 * (/api/warcs/info?uri= returns every capture of a url — 57 of them for
 * https://kiwifarms.net/).
 *
 * ## Everything here is a no-op without WebMCP
 *
 * `document.modelContext` is undefined unless the browser is in the origin
 * trial or has chrome://flags/#enable-webmcp-testing set. That is nearly every
 * visitor, and they pay one property read.
 *
 * ## untrustedContentHint is not decoration
 *
 * Every tool that returns bytes from a capture sets it. The corpus is 17.8M
 * records of other people's websites; the text these tools return was written
 * by whoever ran the site being archived, which is precisely the indirect
 * prompt-injection case the hint exists for. The corpus-statistics tool is the
 * only one that does not set it, because those numbers are ours.
 *
 * ## What must NEVER happen
 *
 * The offline viewer renders archived third-party pages in an iframe, kept
 * cross-origin on purpose so the `warc-navigate` postMessage origin check means
 * something. WebMCP disables tool registration in cross-origin iframes by
 * default and you opt in per-iframe with allow="tools". Do not ever add that to
 * the viewer iframe: it would let a captured page from 2018 register tools
 * against whatever agent is driving the browser.
 */

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import {
    archiveStatus,
    captureAsOf,
    captureById,
    captureDetail,
    captureTimeline,
    contentTypes,
    redirectChain,
    searchArchive,
    type CaptureInfoRow,
} from "@/lib/api-client"
import { bulkDownloadHref, searchHref, viewHref } from "@/components/WarcSearch/actions"

/**
 * How many rows any one tool will describe.
 *
 * A tool's output is read by a model, so length is a real cost and a long list
 * crowds out the rest of the conversation. Anything truncated says so, with the
 * true total, rather than quietly stopping.
 */
const MAX_ROWS = 25

/** How many captures one download tool call may request. */
const MAX_DOWNLOAD = 25

const day = (iso: string | null | undefined): string => (iso ? String(iso).slice(0, 10) : "unknown date")

const truncated = (shown: number, total: number): string =>
    total > shown ? `\n(${shown} of ${total} shown)` : ""

/** One capture, on one line, in the order a reader cares about. */
const captureLine = (row: CaptureInfoRow): string =>
    [
        day(row.archived_date),
        `HTTP ${row.status}`,
        row.content_type ?? "unknown type",
        `id=${row.warc_custom_id}`,
    ].join("  ")

export default function ArchiveTools() {
    const router = useRouter()

    useEffect(() => {
        const modelContext = document.modelContext

        // Every browser without the origin trial or the flag stops here.
        if (!modelContext) return

        // Aborting unregisters every tool at once, when this unmounts.
        const controller = new AbortController()

        const tools: WebMCP.ModelContextTool[] = [
            /* ---------------------------------------------------------------
             * Finding things
             * ------------------------------------------------------------ */
            {
                name: "search_archive",
                title: "Search the archive",
                description:
                    "Search archived web pages by URL or keyword across every WARC in the collection. " +
                    "Returns matching URLs with a capture count and a record id for each. " +
                    "Use get_capture_timeline for the dates of one URL, or open_capture to show one.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description:
                                'A URL or keyword, for example "kiwifarms.net", "geocities", ' +
                                'or a full URL like "https://example.com/page". An empty string browses everything.',
                        },
                        contentType: {
                            type: "string",
                            description:
                                'Optional MIME filter. A full type ("text/html") or a prefix ("image"). ' +
                                "Call list_content_types for what the corpus actually holds.",
                        },
                        limit: { type: "number", description: "Results to return, 1-25. Default 16." },
                    },
                    required: ["query"],
                },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: ({ query, contentType, limit }, { signal }) =>
                    searchArchive(query ?? "", {
                        contentType,
                        limit: Math.min(Math.max(1, Number(limit) || 16), MAX_ROWS),
                        signal,
                    })
                        .then((res) => {
                            if (res.groups.length === 0) {
                                return `No archived pages match ${JSON.stringify(query)}. The archive holds captures of other sites; try a bare hostname such as "geocities.com".`
                            }

                            const total = res.count_capped
                                ? `more than ${res.total_count - 1}`
                                : String(res.total_count)

                            const lines = res.groups.map(
                                (g) =>
                                    `${g.uri}\n    ${g.count} capture${g.count === 1 ? "" : "s"}, latest ${day(g.responses[0]?.archived_date)}, id=${g.responses[0]?.warc_custom_id}`,
                            )

                            return `${total} matching URLs for ${JSON.stringify(query)}.\n\n${lines.join("\n")}`
                        })
                        .catch(
                            (error) =>
                                `Search failed: ${error?.message ?? error}. The archive backend may be busy; try again or narrow the query.`,
                        ),
            },
            {
                name: "get_capture_timeline",
                title: "When was this URL archived",
                description:
                    "Every capture of one exact URL, newest first, with the date and HTTP status of each. " +
                    "This is the archive's history for that URL. Give the full URL including scheme — " +
                    "http:// and https:// are different URLs here and have different histories.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: {
                            type: "string",
                            description: 'The exact URL, for example "https://kiwifarms.net/".',
                        },
                    },
                    required: ["url"],
                },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: ({ url }, { signal }) =>
                    captureTimeline(url, signal)
                        .then((rows) => {
                            if (!rows.length) {
                                return `No captures of ${url}. Note that scheme matters — if you tried https://, try http://, or use search_archive to find the exact URL the archive holds.`
                            }

                            const sorted = [...rows].sort((a, b) =>
                                String(b.archived_date).localeCompare(String(a.archived_date)),
                            )
                            const shown = sorted.slice(0, MAX_ROWS)

                            return (
                                `${rows.length} capture${rows.length === 1 ? "" : "s"} of ${url}, ` +
                                `from ${day(sorted[sorted.length - 1].archived_date)} to ${day(sorted[0].archived_date)}:\n\n` +
                                shown.map(captureLine).join("\n") +
                                truncated(shown.length, rows.length)
                            )
                        })
                        .catch((error) => `Could not read the timeline for ${url}: ${error?.message ?? error}`),
            },
            {
                name: "get_capture_as_of",
                title: "What did this URL look like on a date",
                description:
                    "The capture of a URL closest to a given date — the archive's answer to " +
                    '"what did this look like then". Returns one capture with its real date, which may ' +
                    "differ from the date asked for, since it returns the nearest one held. " +
                    "Follow with open_capture to show it to the user.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The exact URL, including http:// or https://." },
                        date: {
                            type: "string",
                            description:
                                'The date of interest as YYYY-MM-DD, for example "2018-08-01". ' +
                                "Omit for the most recent capture.",
                        },
                    },
                    required: ["url"],
                },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: ({ url, date }, { signal }) =>
                    captureAsOf(url, date, signal)
                        .then((rows) => {
                            const row = Array.isArray(rows) ? rows[0] : rows

                            if (!row) {
                                return `No capture of ${url} near ${date ?? "now"}. Use get_capture_timeline to see which dates exist, or search_archive to find the URL.`
                            }

                            const asked = date ? ` (asked for ${date})` : ""

                            return (
                                `Nearest capture of ${url}${asked}:\n` +
                                `  archived ${day(row.archived_date)}\n` +
                                `  HTTP ${row.status}\n` +
                                `  id=${row.warc_custom_id}\n` +
                                (row.status >= 300 && row.status < 400
                                    ? "  This capture is a redirect — call resolve_redirect_chain to see where it goes.\n"
                                    : "")
                            )
                        })
                        .catch((error) => `Lookup failed for ${url}: ${error?.message ?? error}`),
            },
            {
                name: "list_content_types",
                title: "Content types in the archive",
                description:
                    "The MIME types the archive actually holds, usable as the contentType filter on search_archive.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
                execute: (_input, { signal }) =>
                    contentTypes(signal)
                        .then((types) =>
                            types.length
                                ? `${types.length} content types held. Common ones first:\n\n` +
                                  [
                                      "text/html", "image/jpeg", "image/png", "image/gif", "text/css",
                                      "application/javascript", "application/json", "video/mp4", "text/plain",
                                  ]
                                      .filter((t) => types.includes(t))
                                      .join(", ") +
                                  `\n\nAll: ${types.join(", ")}`
                                : "The content type list is empty, which means the backend could not be reached.",
                        )
                        .catch((error) => `Could not list content types: ${error?.message ?? error}`),
            },

            /* ---------------------------------------------------------------
             * Understanding one capture
             * ------------------------------------------------------------ */
            {
                name: "get_capture_detail",
                title: "Details of one capture",
                description:
                    "The response and request recorded for one capture: status, content type, headers, " +
                    "the server's IP, and whether it is a redirect. Takes a record id from search_archive, " +
                    "get_capture_timeline or get_capture_as_of — ids cannot be guessed.",
                inputSchema: {
                    type: "object",
                    properties: {
                        recordId: {
                            type: "string",
                            description:
                                "The capture's warc_custom_id, of the form " +
                                "warcs/file.warc::https://example.com/::<uuid>",
                        },
                    },
                    required: ["recordId"],
                },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: ({ recordId }, { signal }) =>
                    captureDetail(recordId, signal)
                        .then((d: any) => {
                            if (!d || d.error) {
                                return `No capture with id ${recordId}. Get a valid id from search_archive or get_capture_timeline first.`
                            }

                            const response = d.response ?? {}

                            return [
                                `URL: ${d.uri}`,
                                `Archived: ${d.archived_date}`,
                                `Status: ${response.status ?? "unknown"} ${response.http_version ?? ""}`.trim(),
                                `Content-Type: ${response.content_type ?? "unknown"}`,
                                `Server IP: ${d.ip ?? "not recorded"}`,
                                `Redirect: ${d.is_redirect ? "yes — call resolve_redirect_chain" : "no"}`,
                                `Request recorded: ${d.request ? "yes" : "no"}`,
                            ].join("\n")
                        })
                        .catch((error) => `Could not read capture ${recordId}: ${error?.message ?? error}`),
            },
            {
                name: "resolve_redirect_chain",
                title: "Where does this URL redirect to",
                description:
                    "Follows an archived URL's redirects hop by hop, showing each status, its Location " +
                    "header and where that resolved to. Use when a capture is a 3xx, or to explain why a " +
                    "link leads somewhere unexpected.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The URL to follow. Provide this or recordId." },
                        recordId: { type: "string", description: "A capture id to follow from instead of a URL." },
                    },
                },
                annotations: { readOnlyHint: true, untrustedContentHint: true },
                execute: ({ url, recordId }, { signal }) => {
                    if (!url && !recordId) return Promise.resolve("Give either a url or a recordId to follow.")

                    return redirectChain({ url, recordId }, signal)
                        .then((rows) => {
                            if (!rows.length) return `Nothing archived at ${url ?? recordId}.`

                            const hops = rows.map(
                                (r) =>
                                    `  hop ${r.hop ?? 0}: HTTP ${r.status}  ${r.uri}` +
                                    (r.location_header ? `\n      Location: ${r.location_header}` : "") +
                                    (r.resolved_location ? `\n      resolves to: ${r.resolved_location}` : ""),
                            )

                            return (
                                `${rows.length} hop${rows.length === 1 ? "" : "s"} from ${url ?? recordId}:\n` +
                                hops.slice(0, MAX_ROWS).join("\n") +
                                truncated(Math.min(rows.length, MAX_ROWS), rows.length)
                            )
                        })
                        .catch((error) => `Could not resolve redirects: ${error?.message ?? error}`)
                },
            },

            /* ---------------------------------------------------------------
             * The corpus itself. Our numbers, so no untrusted hint.
             * ------------------------------------------------------------ */
            {
                name: "get_archive_status",
                title: "Archive size and health",
                description:
                    "How much this archive holds: WARC file count, total bytes on disk, and when those " +
                    "numbers were last read. Use to answer questions about the archive itself rather than " +
                    "about any page in it.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
                execute: (_input, { signal }) =>
                    archiveStatus(signal)
                        .then((s) =>
                            s.status === "ok"
                                ? `${s.files.toLocaleString()} WARC files, ${(s.total_bytes / 1e12).toFixed(2)} TB on disk. ` +
                                  `Figures read ${s.date}.`
                                : `The archive backend reported a problem: ${s.message ?? "unknown"}.`,
                        )
                        .catch((error) => `Could not reach the archive backend: ${error?.message ?? error}`),
            },

            /* ---------------------------------------------------------------
             * Acting. These change what the user sees or what lands on their disk.
             * ------------------------------------------------------------ */
            {
                name: "open_capture",
                title: "Show a capture to the user",
                description:
                    "Navigates this browser tab to the viewer for one capture, so the user can see the " +
                    "archived page as it was served. Takes a record id from one of the lookup tools. " +
                    "This changes what is on screen; it does not download or modify anything.",
                inputSchema: {
                    type: "object",
                    properties: {
                        recordId: { type: "string", description: "The capture's warc_custom_id." },
                    },
                    required: ["recordId"],
                },
                // Not read-only: it navigates. Not consequential: it is reversible
                // with the back button and writes nothing.
                annotations: { readOnlyHint: false, consequentialHint: false },
                execute: ({ recordId }, { signal }) =>
                    // Confirm the id resolves BEFORE navigating, so a bad id is an
                    // explanation rather than a viewer page showing nothing.
                    captureById(recordId, signal)
                        .then((rows) => {
                            if (!rows.length) {
                                return `No capture with id ${recordId}, so there is nothing to show. Find one with search_archive first.`
                            }

                            router.push(viewHref(recordId))

                            return `Showing the ${day(rows[0].archived_date)} capture of ${rows[0].uri}.`
                        })
                        .catch((error) => `Could not open that capture: ${error?.message ?? error}`),
            },
            {
                name: "search_and_show",
                title: "Search and show the results page",
                description:
                    "Runs a search and navigates the user to the results page for it. Use when the user " +
                    "wants to browse results themselves rather than have them summarised.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "A URL or keyword to search for." },
                        contentType: { type: "string", description: "Optional MIME filter." },
                    },
                    required: ["query"],
                },
                annotations: { readOnlyHint: false, consequentialHint: false },
                execute: ({ query, contentType }) => {
                    /*
                     * searchHref, not a hand-built path. The slug is encoded in a way
                     * that is easy to get wrong — that exact mistake was a live bug
                     * where every URL search returned other sites' image proxies —
                     * and routing through the same builder the search box uses means
                     * this cannot drift from it.
                     */
                    router.push(searchHref(query ?? "", { contentType }))

                    return Promise.resolve(`Showing search results for ${JSON.stringify(query)}.`)
                },
            },
            {
                name: "download_captures",
                title: "Download captures as a zip",
                description:
                    "Downloads one or more captures to the user's computer as a single zip. " +
                    "Takes record ids from the lookup tools. This writes files to their disk.",
                inputSchema: {
                    type: "object",
                    properties: {
                        recordIds: {
                            type: "array",
                            items: { type: "string" },
                            description: `Capture ids to include, at most ${MAX_DOWNLOAD}.`,
                        },
                    },
                    required: ["recordIds"],
                },
                /*
                 * Consequential, and it is the only tool here that is.
                 *
                 * It writes to the user's disk and the result can be very large —
                 * captures in this corpus run to gigabytes, and bulkDownloadHref
                 * will happily pack dozens into one request. The hint is what makes
                 * the browser ask the user first.
                 */
                annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true },
                execute: ({ recordIds }) => {
                    const ids = Array.isArray(recordIds) ? recordIds.filter(Boolean).slice(0, MAX_DOWNLOAD) : []

                    if (!ids.length) return Promise.resolve("No capture ids given, so there is nothing to download.")

                    const { href, included, dropped } = bulkDownloadHref(ids)

                    if (!included) {
                        return Promise.resolve(
                            "Those ids are too long to request together. Ask for fewer captures at a time.",
                        )
                    }

                    // An anchor rather than location.href, so the browser treats it as
                    // a download and the page the user is reading stays put.
                    const link = document.createElement("a")

                    link.href = href
                    link.rel = "noopener"
                    document.body.appendChild(link)
                    link.click()
                    link.remove()

                    return Promise.resolve(
                        `Downloading ${included} capture${included === 1 ? "" : "s"} as a zip.` +
                            (dropped ? ` ${dropped} did not fit and were left out.` : ""),
                    )
                },
            },
        ]

        /*
         * Registered individually rather than in one chain, so one rejection
         * cannot take the rest with it. A failure here is logged and otherwise
         * ignored: WebMCP is an enhancement, and a site that breaks because an
         * experimental API refused a tool would be a worse site.
         */
        tools.forEach((tool) => {
            modelContext
                .registerTool(tool, { signal: controller.signal })
                .catch((error) => console.warn(`webmcp: could not register ${tool.name}:`, error))
        })

        return () => controller.abort()
    }, [router])

    // Registration only. Nothing to draw.
    return null
}
