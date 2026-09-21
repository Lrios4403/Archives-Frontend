/*
 * The archive API, callable from the BROWSER.
 *
 * lib/db.tsx cannot be used from a client component — it imports `next/cache`
 * and `next/navigation`, neither of which exists on the client — so anything
 * running in the browser needs its own small layer. This is it.
 *
 * ## Relative paths, deliberately
 *
 * Every url here is relative, never PUBLIC_API_URL. Two reasons, in order of
 * importance:
 *
 *   1. The Bun backend sends no Access-Control-Allow-Origin — verified, and
 *      already noted in next.config.mjs. The moment the frontend and backend are
 *      different origins, an absolute fetch from JS is blocked by the browser.
 *      A relative path is same-origin by construction and cannot be.
 *   2. It needs no environment variable to be set correctly per deployment.
 *
 * nginx on the VPS proxies `location ^~ /api/warcs/` straight to the backend, so
 * these resolve without passing through Next at all. This follows the one
 * existing precedent in the codebase: components/WarcView/Viewer.tsx, which
 * fetches `/api/warcs/near?...` relatively for exactly this reason.
 *
 * PUBLIC_API_URL still exists and is still correct for the one thing that needs
 * an absolute, deliberately CROSS-origin url: the viewer iframe, whose separate
 * origin is what makes the `warc-navigate` postMessage origin check meaningful.
 * Do not "simplify" these onto it.
 *
 * ## Note on /api/history
 *
 * There is a /api/history route registered in backend/webserver.ts and it is
 * NOT reachable from a browser: nginx proxies `/api/warcs/` only, so /api/history
 * falls through to Next and answers 404 with an html error page. Measured.
 * captureTimeline below uses /api/warcs/info?uri= instead, which returns the same
 * thing — every capture of a url — and does work.
 */

/** A capture row as /api/warcs/info returns it. */
export interface CaptureInfoRow {
    id: string;
    record_id: string;
    warc_custom_id: string;
    file_path: string | null;
    byte_offset: string | number | null;
    byte_length: string | number | null;
    status: number;
    http_version: string;
    headers: Record<string, unknown> | string | null;
    content_type: string | null;
    uri: string | null;
    archived_date: string;
    /** Only present on /api/warcs/path rows. */
    hop?: number;
    location_header?: string | null;
    resolved_location?: string | null;
}

export interface SearchGroup {
    uri: string;
    count: number;
    responses: Array<{
        response_id: number;
        status: number;
        last_modified: string | null;
        archived_date: string;
        warc_custom_id: string;
        uri: string;
    }>;
}

export interface SearchResponse {
    total_count: number;
    count_capped?: boolean;
    groups: SearchGroup[];
    next_cursor?: { level: number; uri: string } | null;
}

export interface ArchiveStatus {
    status: "ok" | "error";
    files: number;
    total_bytes: number;
    date: string;
    scan_ms?: number;
    message?: string;
}

/**
 * How long a browser-side call may take before it is abandoned.
 *
 * Shorter than the server-side BACKEND_TIMEOUT_MS (10s) on purpose: these calls
 * are made by an agent that is waiting on a person, and the backend's own
 * ceiling is 7s, so anything past that is a stall rather than a slow answer.
 */
const CLIENT_TIMEOUT_MS = 9_000;

/**
 * One fetch, one shape, one failure mode.
 *
 * Throws on a non-2xx rather than returning a degraded value, because every
 * caller here is a WebMCP tool and a tool turns the throw into a sentence the
 * agent can act on. That is the opposite of lib/db.tsx's policy, where a failure
 * has to become renderable markup instead.
 */
const getJson = <T>(path: string, signal?: AbortSignal): Promise<T> => {
    /*
     * Both signals matter: the caller's (the agent cancelled, or the component
     * unmounted) and the timeout's. AbortSignal.any settles on whichever fires
     * first and is supported everywhere WebMCP is.
     */
    const timeout = AbortSignal.timeout(CLIENT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    return fetch(path, { signal: combined, headers: { accept: "application/json" } }).then((res) => {
        if (!res.ok) throw new Error(`${res.status} from ${path.split("?")[0]}`);

        return res.json() as Promise<T>;
    });
};

/** Matching URIs, newest-relevant first. `contentType` may be a full type or a prefix like "image". */
export const searchArchive = (
    query: string,
    options: { contentType?: string; limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<SearchResponse> => {
    const params = new URLSearchParams({
        q: query,
        limit: String(options.limit ?? 16),
        offset: String(options.offset ?? 0),
    });

    if (options.contentType) params.set("content_type", options.contentType);

    return getJson<SearchResponse>(`/api/warcs/search?${params}`, options.signal);
};

/**
 * Every capture of one url, which is the archive's timeline for it.
 *
 * /api/warcs/info?uri= rather than /api/history?url= — see the note at the top
 * of this file for why the latter cannot be called from a browser.
 */
export const captureTimeline = (url: string, signal?: AbortSignal): Promise<CaptureInfoRow[]> =>
    getJson<CaptureInfoRow[]>(`/api/warcs/info?uri=${encodeURIComponent(url)}`, signal);

/** One capture, by its warc_custom_id. */
export const captureById = (recordId: string, signal?: AbortSignal): Promise<CaptureInfoRow[]> =>
    getJson<CaptureInfoRow[]>(`/api/warcs/info?id=${encodeURIComponent(recordId)}`, signal);

/**
 * The capture nearest a point in time — the archive's closest answer to "what
 * did this look like then".
 *
 * Measured against http://kiwifarms.net/: dateNear=2017-01-01 resolves to the
 * 2017-07-20 capture, 2018-08-01 to 2018-07-13, 2021-07-01 to 2021-07-09. There
 * is no UI anywhere on the site for this.
 */
export const captureAsOf = (
    url: string,
    date?: string,
    signal?: AbortSignal,
): Promise<CaptureInfoRow[]> => {
    const params = new URLSearchParams({ uri: url });

    if (date) params.set("dateNear", date);

    return getJson<CaptureInfoRow[]>(`/api/warcs/near?${params}`, signal);
};

/** The resolved redirect chain for a url or a capture id, one row per hop. */
export const redirectChain = (
    target: { url?: string; recordId?: string; maxHops?: number },
    signal?: AbortSignal,
): Promise<CaptureInfoRow[]> => {
    const params = new URLSearchParams();

    if (target.url) params.set("uri", target.url);
    if (target.recordId) params.set("id", target.recordId);
    params.set("max_hops", String(target.maxHops ?? 20));

    return getJson<CaptureInfoRow[]>(`/api/warcs/path?${params}`, signal);
};

/** Response plus request for one capture, including whether it is a redirect. */
export const captureDetail = (recordId: string, signal?: AbortSignal): Promise<Record<string, unknown>> =>
    getJson<Record<string, unknown>>(`/api/warcs/detail?id=${encodeURIComponent(recordId)}`, signal);

/** Corpus-level numbers: file count, total bytes, when they were read. */
export const archiveStatus = (signal?: AbortSignal): Promise<ArchiveStatus> =>
    getJson<ArchiveStatus>("/api/warcs/status", signal);

/**
 * MIME types present in the corpus, with the junk removed.
 *
 * The endpoint returns 532 entries and roughly a quarter of them are not media
 * types at all. They come from real, broken Content-Type headers in archived
 * pages, so they are faithful data and useless as choices. Measured samples of
 * what is dropped:
 *
 *   "*&#47;*"  "$mime_type"  "$type_fichier"  "16"  "5184000"  "charset=utf-8"
 *   "content-type: image/gif"          — the header name captured with the value
 *   "\"application/octet-stream\""     — quoted by the origin server
 *   "application/javascript, text/javascript, text/javascript, ..."
 *                                      — a server that sent Content-Type twice,
 *                                        joined on ", ", so it is one string
 *
 * 532 in, 395 out. Every entry is genuinely distinct (checked: 532 unique of
 * 532), so this is filtering, not deduplication.
 */
const MEDIA_TOP_LEVEL = new Set([
    "application", "audio", "font", "image", "message", "model", "multipart", "text", "video",
]);

const WELL_FORMED_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/;

export const isUsableContentType = (type: string): boolean =>
    WELL_FORMED_TYPE.test(type) && MEDIA_TOP_LEVEL.has(type.split("/")[0]);

export const contentTypes = (signal?: AbortSignal): Promise<string[]> =>
    getJson<string[]>("/api/warcs/content-types", signal).then((all) =>
        (Array.isArray(all) ? all : []).filter(isUsableContentType),
    );
