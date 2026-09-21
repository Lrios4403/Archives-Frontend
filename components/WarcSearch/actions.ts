/**
 * Where a search result's action buttons point.
 *
 * Extracted from the JSX so the url building is testable on its own. That matters
 * more than it looks: a `warc_custom_id` is
 *
 *     warcs/5am.warc::https://example.com/page?a=b::<uuid>
 *
 * which contains `/`, `:`, `?` and `&` — every character that would end a query
 * parameter early. Built by hand in a template literal it silently truncates at
 * the first `?`, and the request that arrives asks for a capture nobody has.
 */

/**
 * The download endpoint, same-origin.
 *
 * Relative on purpose. next.config.mjs rewrites `/api/warcs/download` to the Bun
 * backend, so the browser sees one origin — which is what makes the `download`
 * attribute work (it is ignored cross-origin) and keeps the backend's location in
 * one place rather than inlined into every component that links to it.
 */
const DOWNLOAD = "/api/warcs/download";

/**
 * A zip of one capture and, if it is a document, what it references.
 *
 * No `resources=0` here: a downloaded page whose stylesheet and images are
 * absolute urls into a site that may no longer exist is not a smaller page, it is
 * a broken one. The server decides what a document needs; this only names the
 * capture.
 */
export const downloadHref = (recordId: string): string =>
    `${DOWNLOAD}?ids=${encodeURIComponent(recordId)}`;

/**
 * A filename for the `download` attribute.
 *
 * A hint only — the response sends `Content-Disposition` with a uuid-stamped name
 * and that wins. This exists so the browser has something readable to show in its
 * downloads list before the headers arrive.
 */
export const downloadName = (recordId: string): string => {
    // The middle segment of a warc_custom_id is the archived url.
    const url = recordId.split("::")[1] ?? recordId;

    let host = "archive";

    try {
        host = new URL(url).host || host;
    } catch {
        // Not a url. "archive" is a fine answer.
    }

    return `${host.replace(/[^A-Za-z0-9.-]+/g, "-")}.zip`;
};

/**
 * The in-app viewer for one capture.
 *
 * Relative, like DOWNLOAD above, and for the same reason: it is a route in this
 * app, and hardcoding an origin would break every deployment that is not the one
 * it was written on.
 */
export const viewHref = (recordId: string): string =>
    `/warcs/view?id=${encodeURIComponent(recordId)}`;

/**
 * The same link, absolute, for putting on the clipboard.
 *
 * A relative url is useless once it leaves the page — pasted into a chat or a
 * notes file it is just `/warcs/view?id=…`, which resolves against whatever the
 * reader is looking at, if anything. So the clipboard gets an absolute one.
 *
 * MUST NOT be called during render. `window.location.origin` does not exist on
 * the server, so a component that put this in an attribute would render one
 * string on the server and a different one in the browser, and React would
 * report a hydration mismatch on every result row. Call it from the event
 * handler, where there is no server render to disagree with.
 */
export const viewUrlForClipboard = (recordId: string): string =>
    new URL(viewHref(recordId), window.location.origin).href;

/**
 * Text to the clipboard, or false if it could not get there.
 *
 * Two paths, because the good one is not always available. `navigator.clipboard`
 * exists only in a secure context — https, or localhost. Reaching the dev server
 * over the LAN (`http://192.168.1.x:3001`) is not one, and there the API is
 * simply absent rather than failing, so a bare `navigator.clipboard.writeText`
 * throws TypeError on undefined and the button appears to do nothing at all.
 *
 * The fallback is deprecated and still works everywhere. It is behind the modern
 * path rather than in front of it, so it is only reached when there is no
 * alternative.
 *
 * Returns a boolean instead of throwing: the caller's job is to tell the reader
 * whether their clipboard has the link, and both outcomes are ordinary.
 */
export const copyText = async (text: string): Promise<boolean> => {
    try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);

            return true;
        }
    } catch {
        // Permission refused, or a document that is not focused. Try the other way.
    }

    try {
        const area = document.createElement("textarea");

        area.value = text;
        area.setAttribute("readonly", "");
        // Off-screen rather than hidden: `display:none` and `visibility:hidden`
        // are not selectable, and the selection is what gets copied.
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";

        document.body.appendChild(area);
        area.select();

        const copied = document.execCommand("copy");

        area.remove();

        return copied;
    } catch {
        return false;
    }
};

/**
 * How long the request head may get, in bytes.
 *
 * Bun rejects a request whose head passes 16 KiB with 431, and a bulk download
 * puts every id in the query string — so the ceiling on "download all of these"
 * is the URL's length, not the route's own MAX_REQUESTED of 500. Measured
 * against the running server: 16,207 bytes of url answered 200 and 16,433
 * answered 431.
 *
 * 12,000 leaves roughly 4 KiB for the rest of the head. That is not padding: the
 * limit covers Host, User-Agent, Accept, Accept-Encoding, Referer and any cookie
 * the deployment sets, and a Chrome User-Agent alone is ~120 bytes while a
 * session cookie can be hundreds. The request line is the only part we control,
 * so it is the part that has to stay well clear.
 */
export const MAX_DOWNLOAD_URL_BYTES = 12_000;

export interface BulkDownload {
    href: string;
    /** How many ids the link actually carries. */
    included: number;
    /** How many were asked for but left out because the url would be too long. */
    dropped: number;
}

/**
 * A link that downloads several captures as one zip.
 *
 * Budgeted by BYTES rather than by a count of ids, because ids are not a fixed
 * width — an id carries the archived url, so one site's captures can be three
 * times another's. A count tuned for short urls silently produces a 431 for long
 * ones, and a count safe for long urls throws away most of the allowance for
 * short ones.
 *
 * What does not fit is REPORTED rather than dropped quietly, so the caller can
 * say so on the button. A download that claims to be everything and is the first
 * eighty of two hundred is the kind of wrong that is never noticed.
 */
export const bulkDownloadHref = (recordIds: readonly string[]): BulkDownload => {
    const parts: string[] = [];

    let length = DOWNLOAD.length + 1; // the path, plus "?"

    for (const recordId of recordIds) {
        const part = `ids=${encodeURIComponent(recordId)}`;
        // +1 for the "&" joining it to whatever is already there.
        const cost = part.length + (parts.length > 0 ? 1 : 0);

        if (length + cost > MAX_DOWNLOAD_URL_BYTES) break;

        parts.push(part);
        length += cost;
    }

    return {
        href: `${DOWNLOAD}?${parts.join("&")}`,
        included: parts.length,
        dropped: recordIds.length - parts.length,
    };
};

/** A filename hint for a zip holding every capture of one site. */
export const bulkDownloadName = (siteUrl: string): string => {
    let host = "archive";

    try {
        host = new URL(siteUrl).host || host;
    } catch {
        // Not a url — the caller passes a display string, which may be anything.
    }

    return `${host.replace(/[^A-Za-z0-9.-]+/g, "-")}-captures.zip`;
};

/* ---------------------------------------------------------------------------
 * Search URLs
 *
 * The query lives in the PATH now — /warcs/search/geocities.com rather than
 * /warcs/search?q=geocities.com — which is what lets /warcs/search itself stay a
 * static page. A route that reads searchParams cannot be prerendered, and under
 * Cache Components anything it defers behind <Suspense> is postponed and never
 * hydrates, so the landing page's own search box was dead.
 *
 * Filters stay in the query string. `page` and `content_type` narrow a result
 * set; they do not identify one, and the results route is blocking anyway
 * (instant = false), so reading them there costs nothing.
 *
 * Old `?q=` links are forwarded into the path by frontend/proxy.ts — the Next 16
 * proxy, which is what middleware.ts was renamed to. NOT by next.config.mjs;
 * declarative redirects there got three separate things wrong and the reasons
 * are written up in that file.
 * ------------------------------------------------------------------------ */

/** Where the results live. */
const SEARCH = "/warcs/search";

/**
 * The slug that means "every archive".
 *
 * An empty query is a REAL search in this app — the backend matches
 * `uri ILIKE '%' || q || '%'`, so it returns everything — and an empty path
 * segment is not addressable, so it needs a name.
 *
 * The cost is one collision: searching for the literal text "all" browses
 * everything instead. That is the whole overlap, it fails toward showing more
 * rather than fewer results, and the alternative is a sigil in the URL that
 * every reader has to look at forever.
 */
export const BROWSE_ALL_SLUG = "all";

/**
 * What Next actually does to a dynamic segment, measured rather than assumed.
 *
 * This was wrong for a long time and it is worth writing down precisely, because
 * the bug it caused was silent: every search for a url returned the wrong rows.
 *
 *   1. `params.slug` is the RAW path segment. Next performs ZERO decodes on it.
 *      Measured:  /warcs/search/caf%C3%A9    -> params.slug "caf%C3%A9"
 *                 /warcs/search/caf%25C3%25A9 -> params.slug "caf%25C3%25A9"
 *
 *   2. Next nevertheless VALIDATES the segment by decoding it TWICE, and answers
 *      500 if either decode throws. Measured, by http status:
 *                 100%25      500        %25    500        %2541      200
 *                 100%2525    200        a%25b  500        50%2525off 200
 *      Exactly: accepted iff decodeURIComponent(decodeURIComponent(S)) survives.
 *
 * The old code encoded twice and decoded once, on the belief that Next removed
 * the other layer. It does not — so "https://kiwifarms.st/" reached the backend
 * as "https%3A%2F%2Fkiwifarms.st%2F" and matched the only urls that contain that
 * text literally: other sites' image proxies, with the target url in a query
 * parameter. The site looked like it had no kiwifarms.st captures at all.
 */

/**
 * encodeURIComponent, minus the one input that makes it throw.
 *
 * A lone surrogate — half an emoji, which is exactly what a partial paste or a
 * truncated clipboard produces — is not valid UTF-16 and encodeURIComponent
 * answers with a URIError rather than a string. Unguarded that propagates out of
 * the submit handler and the search button simply does nothing.
 *
 * The scan only runs on the failing path, so the common case pays nothing.
 */
const encodeOnce = (text: string): string => {
    try {
        return encodeURIComponent(text);
    } catch {
        return encodeURIComponent(
            text.replace(/[\uD800-\uDFFF]/g, (c, i) => {
                const code = c.charCodeAt(0);

                if (code <= 0xdbff) {
                    const next = text.charCodeAt(i + 1);

                    return next >= 0xdc00 && next <= 0xdfff ? c : "�";
                }

                const prev = text.charCodeAt(i - 1);

                return prev >= 0xd800 && prev <= 0xdbff ? c : "�";
            }),
        );
    }
};

/**
 * The path segment for a query.
 *
 * One encoding layer, plus a second one applied ONLY to the percent signs the
 * query itself contains. That asymmetry is the whole design:
 *
 *   - Rule 2 above throws on exactly one character, `%`. Every other escape
 *     survives a double decode untouched, so double-encoding them buys nothing
 *     and costs legibility.
 *   - So `https://kiwifarms.st/` becomes `https%3A%2F%2Fkiwifarms.st%2F` (which
 *     a reader can still read) instead of `https%253A%252F%252Fkiwifarms.st%252F`,
 *     while `100%` still becomes `100%2525` and still answers 200.
 *
 * Shorter than a blanket double-encode on ~87% of queries and identical on the
 * rest; verified against the running server for `?`, `#`, `\`, `/`, spaces,
 * multi-byte UTF-8, and bare percent signs.
 *
 * The two special cases at the end are structural, not cosmetic:
 *
 *   "all"     collides with BROWSE_ALL_SLUG, so the literal query would browse
 *             everything instead of searching for the word. `%2561ll` decodes
 *             twice to "all" and is not the sentinel.
 *   "." / ".." are dot segments. The BROWSER normalises /warcs/search/.. to
 *             /warcs before the request is ever sent, so the route never sees
 *             it — measured: a 308 to /warcs. Encoded, the segment survives.
 */
export const slugForQuery = (query: string): string => {
    const trimmed = query.trim();

    if (trimmed === "") return BROWSE_ALL_SLUG;

    const once = encodeOnce(trimmed);
    // A `%25` in the once-encoded form can only have come from a literal `%` in
    // the query, because every other escape is `%` followed by two hex digits
    // that are not "25". Re-encoding just those is what keeps rule 2 satisfied.
    const slug = once.includes("%25") ? encodeOnce(once) : once;

    if (slug === BROWSE_ALL_SLUG) return "%2561ll";
    if (slug === "." || slug === "..") return slug.replace(/\./g, "%252E");

    return slug;
};

/**
 * The query a slug stands for. Two decodes, mirroring slugForQuery.
 *
 * Two and not one because `params.slug` arrives raw (rule 1). The second decode
 * is a no-op for any query that needed no escaping, which is most of them.
 *
 * Each step is individually tolerant, because a reader can type anything into
 * the address bar and decodeURIComponent THROWS on a stray "%" rather than
 * returning it. A hand-typed url should search for what it says, not crash the
 * route. Returning the partially-decoded text on failure also means an older
 * single-encoded link — anything bookmarked or indexed before this change —
 * still resolves to the query it always meant.
 */
export const queryFromSlug = (slug: string): string => {
    if (slug === BROWSE_ALL_SLUG) return "";

    let text = slug;

    for (let pass = 0; pass < 2; pass++) {
        try {
            text = decodeURIComponent(text);
        } catch {
            return text;
        }
    }

    return text;
};

export interface SearchLinkOptions {
    page?: number;
    contentType?: string | null;
    /**
     * Where the PREVIOUS page ended, so this link can be answered by a seek
     * instead of an OFFSET. Measured 49-227x cheaper and flat in depth.
     *
     * Only meaningful on a link to the immediately following page — it is a
     * position, not a page number, and pairing it with any other page would
     * label a page with rows that are not on it. Pagination only ever attaches
     * it to `next`.
     */
    cursor?: { level: number; uri: string } | null;
}

/** A link to the results for `query`, with optional filters. */
export const searchHref = (query: string, options: SearchLinkOptions = {}): string => {
    const params = new URLSearchParams();

    // Page 1 is the default, so it is left out — otherwise every link from the
    // search box would carry "?page=1" and the clean url would never be seen.
    if (options.page !== undefined && options.page > 1) params.set("page", String(options.page));
    if (options.contentType) params.set("content_type", options.contentType);
    if (options.cursor) {
        params.set("after_level", String(options.cursor.level));
        params.set("after_uri", options.cursor.uri);
    }

    const query_ = params.toString();

    return `${SEARCH}/${slugForQuery(query)}${query_ ? `?${query_}` : ""}`;
};

/**
 * A DOM id for one site's block on a results page, and the fragment that reaches it.
 *
 * Sanitised to `[A-Za-z0-9-]` rather than percent-encoded, and that is the whole
 * reason this exists as a function. `#site-https%3A%2F%2Fx` looks like it would
 * work and does not: a browser matches a fragment against the DECODED string, so
 * the link would look for an element whose id is literally `site-https://x`
 * while the element carries the encoded form. The link silently jumps nowhere.
 *
 * Not unique on its own — two urls differing only in punctuation collapse to the
 * same slug — so the caller dedupes across the page it is building. See
 * siteAnchors.
 */
export const siteAnchorId = (uri: string): string => {
    const bare = uri
        .replace(/^[a-z]+:\/\//i, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);

    return `site-${bare || "x"}`;
};

/**
 * One id per uri, guaranteed distinct within the page.
 *
 * A duplicate id makes `#foo` ambiguous and the browser takes the first, so two
 * entries in the jump list would scroll to the same place. Suffixed rather than
 * hashed so the common case stays readable in the address bar.
 */
export const siteAnchors = (uris: readonly string[]): string[] => {
    const used = new Map<string, number>();

    return uris.map((uri) => {
        const base = siteAnchorId(uri);
        const seen = used.get(base) ?? 0;

        used.set(base, seen + 1);

        return seen === 0 ? base : `${base}-${seen + 1}`;
    });
};

/** How a url reads in the jump list: no scheme, no trailing slash. */
export const siteLabel = (uri: string): string => {
    try {
        const url = new URL(uri);
        const shown = `${url.host}${url.pathname}${url.search}`;

        return shown.length > 1 ? shown.replace(/\/$/, "") : url.host;
    } catch {
        return uri;
    }
};
