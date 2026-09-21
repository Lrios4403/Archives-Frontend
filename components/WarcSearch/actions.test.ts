// bun test components/WarcSearch/actions.test.ts
//
// The download link, which was `href="#"` until the server route existed.
//
// The url building is the whole risk, and it is not obvious risk. A
// `warc_custom_id` looks like
//
//     warcs/5am.warc::https://example.com/page?a=b::<uuid>
//
// and contains `/`, `:`, `?` and `&` — every character that ends a query
// parameter early. Interpolated into a template literal without encoding it
// truncates at the first `?` and the server is asked for a capture nobody has,
// which it answers with a valid zip containing nothing but a manifest. A download
// that works and is empty.

import { describe, expect, test } from "bun:test";
import {
    MAX_DOWNLOAD_URL_BYTES,
    bulkDownloadHref,
    bulkDownloadName,
    downloadHref,
    downloadName,
    viewHref,
    BROWSE_ALL_SLUG,
    queryFromSlug,
    searchHref,
    slugForQuery,
    siteAnchorId,
    siteAnchors,
    siteLabel,
} from "./actions";

const ID = "warcs/5am.warc::https://example.com/page?a=b&c=d::0fd4e2a1-1111-2222-3333-444455556666";

describe("downloadHref", () => {
    test("points at the same-origin route, so the download attribute works", () => {
        expect(downloadHref("simple")).toStartWith("/api/warcs/download?ids=");
        expect(downloadHref("simple")).not.toContain("://");
    });

    test("encodes an id whose characters would otherwise end the query", () => {
        const href = downloadHref(ID);

        // Exactly one `?`: the one that starts the query string.
        expect(href.split("?")).toHaveLength(2);
        expect(href).not.toContain("&c=d");
        expect(href).not.toContain("::");
    });

    test("round-trips: what the server parses is what was asked for", () => {
        // The assertion that matters. Anything less is checking that a string
        // contains a substring; this checks the server gets the id back.
        const url = new URL(downloadHref(ID), "http://localhost:3001");

        expect(url.searchParams.get("ids")).toBe(ID);
        expect(url.pathname).toBe("/api/warcs/download");
    });

    test("survives an id with a space or a hash in the archived url", () => {
        for (const id of [
            "warcs/a.warc::https://e.test/a b c::uuid",
            "warcs/a.warc::https://e.test/x#frag::uuid",
            "warcs/a.warc::https://e.test/%2f::uuid",
            "warcs/a.warc::https://e.test/?q=a+b::uuid",
        ]) {
            const url = new URL(downloadHref(id), "http://localhost:3001");

            expect(url.searchParams.get("ids")).toBe(id);
        }
    });

    // No `resources=0`: a page without its stylesheet and images is not a smaller
    // page, it is a broken one. The server decides what a document needs.
    test("does not opt out of resources", () => {
        expect(downloadHref(ID)).not.toContain("resources");
    });
});

describe("downloadName", () => {
    test("names the file after the archived host", () => {
        expect(downloadName(ID)).toBe("example.com.zip");
    });

    test("falls back rather than throwing on an id that is not a url", () => {
        expect(downloadName("not-an-id")).toBe("archive.zip");
        expect(downloadName("")).toBe("archive.zip");
    });

    test("a hostile host cannot smuggle a path into the filename", () => {
        // The attribute is a hint the browser may use as a filename, so it gets
        // the same treatment as a path inside the archive.
        const name = downloadName("warcs/a.warc::https://e.test/..%2f..%2fetc::uuid");

        expect(name).not.toContain("/");
        expect(name).not.toContain("\\");
        expect(name.endsWith(".zip")).toBe(true);
    });
});

describe("viewHref", () => {
    test("points at the in-app viewer, same-origin", () => {
        expect(viewHref("simple")).toStartWith("/warcs/view?id=");
        expect(viewHref("simple")).not.toContain("://");
    });

    test("round-trips an id whose characters would otherwise end the query", () => {
        const url = new URL(viewHref(ID), "http://localhost:3001");

        expect(url.searchParams.get("id")).toBe(ID);
        expect(url.pathname).toBe("/warcs/view");
    });

    // The whole point of the Copy button: what lands on the clipboard has to be
    // the same capture the row is showing, through an absolutisation step.
    test("survives being made absolute", () => {
        const absolute = new URL(viewHref(ID), "https://archives.example.com");

        expect(absolute.origin).toBe("https://archives.example.com");
        expect(absolute.searchParams.get("id")).toBe(ID);
    });
});

describe("bulkDownloadHref", () => {
    const id = (n: number) => `warcs/5am.warc::https://example.com/page-${n}::0fd4e2a1-1111-2222-3333-4444${String(n).padStart(8, "0")}`;

    test("carries every id when they fit", () => {
        const bulk = bulkDownloadHref([id(1), id(2), id(3)]);
        const url = new URL(bulk.href, "http://localhost:3001");

        expect(bulk.included).toBe(3);
        expect(bulk.dropped).toBe(0);
        expect(url.searchParams.getAll("ids")).toEqual([id(1), id(2), id(3)]);
    });

    test("stays under the request-head limit, and says what it left behind", () => {
        // Enough to blow past 12 KB several times over.
        const many = Array.from({ length: 400 }, (_, n) => id(n));
        const bulk = bulkDownloadHref(many);

        expect(bulk.href.length).toBeLessThanOrEqual(MAX_DOWNLOAD_URL_BYTES);
        expect(bulk.included).toBeGreaterThan(0);
        expect(bulk.included).toBeLessThan(many.length);
        // The two halves account for everything asked for. A link that quietly
        // held 80 of 400 would look identical to one that held all of them.
        expect(bulk.included + bulk.dropped).toBe(many.length);
    });

    test("budgets by bytes, so a long url does not get the same count as a short one", () => {
        const short = Array.from({ length: 400 }, (_, n) => `w::u${n}::i${n}`);
        const long = Array.from({ length: 400 }, (_, n) =>
            `warcs/a.warc::https://example.com/${"deep/".repeat(20)}page-${n}::0fd4e2a1-1111-2222-3333-444455556666`);

        expect(bulkDownloadHref(short).included).toBeGreaterThan(bulkDownloadHref(long).included);
        expect(bulkDownloadHref(long).href.length).toBeLessThanOrEqual(MAX_DOWNLOAD_URL_BYTES);
    });

    test("an empty list is a well-formed url rather than a crash", () => {
        const bulk = bulkDownloadHref([]);

        expect(bulk.included).toBe(0);
        expect(bulk.dropped).toBe(0);
        expect(() => new URL(bulk.href, "http://localhost:3001")).not.toThrow();
    });

    test("every id survives encoding, not just the first", () => {
        const nasty = ["warcs/a.warc::https://e.test/?q=a&b::u1", "warcs/a.warc::https://e.test/x#f::u2"];
        const url = new URL(bulkDownloadHref(nasty).href, "http://localhost:3001");

        expect(url.searchParams.getAll("ids")).toEqual(nasty);
    });
});

describe("bulkDownloadName", () => {
    test("names the file after the site", () => {
        expect(bulkDownloadName("https://5amgirlfriend.neocities.org/")).toBe("5amgirlfriend.neocities.org-captures.zip");
    });

    test("falls back rather than throwing on a display string", () => {
        expect(bulkDownloadName("not a url")).toBe("archive-captures.zip");
    });

    test("cannot smuggle a path into the filename", () => {
        const name = bulkDownloadName("https://e.test/..%2f..%2fetc");

        expect(name).not.toContain("/");
        expect(name).not.toContain("\\");
    });
});

describe("search urls", () => {
    test("a query becomes a path segment, not a query string", () => {
        expect(searchHref("geocities.com")).toBe("/warcs/search/geocities.com");
        expect(searchHref("geocities.com")).not.toContain("?");
    });

    test("an empty query is the browse-all slug, not an empty segment", () => {
        // An empty q is a REAL search here (it matches every URI), so it has to
        // be addressable. "/warcs/search/" would be the landing page.
        expect(searchHref("")).toBe("/warcs/search/all");
        expect(searchHref("   ")).toBe("/warcs/search/all");
    });

    test("filters stay in the query string", () => {
        expect(searchHref("myspace", { page: 3 })).toBe("/warcs/search/myspace?page=3");
        expect(searchHref("myspace", { contentType: "text/html" }))
            .toBe("/warcs/search/myspace?content_type=text%2Fhtml");
    });

    test("page 1 is left out, so the clean url is the common one", () => {
        expect(searchHref("myspace", { page: 1 })).toBe("/warcs/search/myspace");
    });

    test("a query that would break a path is encoded", () => {
        for (const q of ["a/b", "a?b", "a#b", "a b", "100%"]) {
            const url = new URL(searchHref(q), "http://localhost:3001");
            // One segment after /warcs/search, whatever the query contained.
            expect(url.pathname.split("/").filter(Boolean)).toHaveLength(3);
        }
    });

    /*
     * Queries chosen to cover every way the encoding has actually broken:
     * url punctuation, spaces, bare percent signs, text that is ITSELF
     * percent-encoded, the browse-all sentinel, dot segments, and multi-byte
     * characters.
     */
    const ADVERSARIAL = [
        "geocities.com", "a b", "a/b", "100%", "all-in", "café", "a?b", "a#b", "50%+50%",
        "https://kiwifarms.st/", "http://kiwifarms.net/",
        "%20", "%25", "%2525", "A%41", "all", ".", "..", "...", "50% off",
        "https%3A%2F%2Fkiwifarms.st%2F", "日本語", "🙂", "a\\b", "a&b", "a=b", "a;b",
    ] as const;

    test("round-trips through the RAW slug, because Next does not decode it", () => {
        /*
         * params.slug is the raw path segment — Next performs ZERO decodes on
         * it. Measured: /warcs/search/caf%C3%A9 arrives as "caf%C3%A9", not
         * "café".
         *
         * The previous version of this test called decodeURIComponent on the
         * slug before handing it over, i.e. it performed one of the two decodes
         * ITSELF. That is the false model the bug was built on, so the test was
         * green while every search for a url returned the wrong rows. Feeding
         * slugForQuery's output in unmodified is the only thing that tests
         * what the route actually does.
         */
        for (const q of ADVERSARIAL) {
            expect(queryFromSlug(slugForQuery(q))).toBe(q);
        }
    });

    test("the reported bug: a pasted url reaches the backend as itself", () => {
        // Searching this returned only other sites' image proxies, because the
        // query arrived at Postgres still encoded and ILIKE matched the urls
        // that contain that text literally.
        const slug = slugForQuery("https://kiwifarms.st/");

        expect(queryFromSlug(slug)).toBe("https://kiwifarms.st/");
        expect(queryFromSlug(slug)).not.toContain("%3A");
    });

    test("every slug survives Next's own validator", () => {
        /*
         * Next validates a dynamic segment by decoding it TWICE and answers 500
         * if either decode throws. Measured by http status against the running
         * server: 100%25 -> 500, 100%2525 -> 200, %25 -> 500, %2541 -> 200.
         *
         * That is the property that keeps "100%" off the 500 path and it was
         * asserted nowhere, which is how an encoder change could quietly start
         * serving errors for a whole class of query.
         */
        for (const q of ADVERSARIAL) {
            const slug = slugForQuery(q);

            expect(() => decodeURIComponent(decodeURIComponent(slug))).not.toThrow();
        }
    });

    test("a url query stays readable rather than double-escaped", () => {
        // Only the query's own percent signs get the second layer, so url
        // punctuation is escaped once and a reader can still read the address.
        expect(slugForQuery("https://kiwifarms.st/")).toBe("https%3A%2F%2Fkiwifarms.st%2F");
        expect(slugForQuery("café")).toBe("caf%C3%A9");
        expect(slugForQuery("a b")).toBe("a%20b");
    });

    test("the literal query 'all' does not browse everything", () => {
        // "all" is the browse-everything sentinel, so the literal word needs a
        // slug that is not it. %2561ll decodes twice to "all".
        expect(slugForQuery("all")).not.toBe(BROWSE_ALL_SLUG);
        expect(queryFromSlug(slugForQuery("all"))).toBe("all");
    });

    test("a dot-segment query cannot walk out of the route", () => {
        // The BROWSER normalises /warcs/search/.. to /warcs before the request
        // is sent — measured: a 308 to /warcs — so the route never sees it.
        for (const q of [".", ".."]) {
            expect(slugForQuery(q)).not.toBe(q);
            expect(slugForQuery(q)).not.toContain(".");
            expect(queryFromSlug(slugForQuery(q))).toBe(q);
        }
    });

    test("half a pasted emoji does not throw", () => {
        // encodeURIComponent answers a URIError on a lone surrogate, which
        // propagated out of the submit handler and made the button do nothing.
        expect(() => slugForQuery("a\uD800b")).not.toThrow();
        expect(() => slugForQuery("\uDE00")).not.toThrow();
    });

    test("a link built from a decoded query is stable, not a ratchet", () => {
        /*
         * The pager and the prefilled search box both rebuild a link from the
         * query the page decoded. While queryFromSlug under-decoded, each hop
         * added an encoding layer: page 2 of a url search asked the backend for
         * a doubly-encoded string and found nothing.
         */
        for (const q of ADVERSARIAL) {
            const once = queryFromSlug(slugForQuery(q));
            const twice = queryFromSlug(slugForQuery(once));

            expect(twice).toBe(q);
        }
    });

    test("a plain query still reads as itself in the address bar", () => {
        // The double encoding must not make the COMMON case ugly.
        for (const q of ["geocities.com", "myspace", "five-am_girlfriend", "a.b.c"]) {
            expect(searchHref(q)).toBe(`/warcs/search/${q}`);
        }
    });

    test("a percent sign survives, because single-encoding 500s the route", () => {
        // /warcs/search/100%25 is "failed to decode param"; %2525 is fine.
        expect(slugForQuery("100%")).toBe("100%2525");
    });

    test("queryFromSlug does not throw on a hand-typed url", () => {
        // decodeURIComponent throws on a stray %; a reader typing nonsense
        // should get a search, not a crash.
        expect(() => queryFromSlug("100%")).not.toThrow();
        expect(queryFromSlug("100%")).toBe("100%");
    });

    test("the browse-all slug maps back to the empty query", () => {
        expect(queryFromSlug(BROWSE_ALL_SLUG)).toBe("");
        expect(queryFromSlug("all")).toBe("");
    });
});

describe("site anchors", () => {
    test("an id is safe in a fragment, so the link actually lands", () => {
        // Percent-encoding is the trap: a browser matches a fragment against the
        // DECODED string, so #site-https%3A%2F%2Fx would look for an element
        // whose id is "site-https://x" and silently scroll nowhere.
        const id = siteAnchorId("https://onionfarms.com/threads/a-b?c=d&e=f");

        expect(id).toMatch(/^site-[A-Za-z0-9-]+$/);
        expect(id).not.toContain("%");
        expect(id).not.toContain("/");
    });

    test("ids are unique across a page, even when urls slugify the same", () => {
        // These differ only in punctuation, so the raw slug collides — and a
        // duplicate id makes the browser take the first, sending two entries in
        // the list to the same place.
        const ids = siteAnchors([
            "https://e.test/a-b",
            "https://e.test/a_b",
            "https://e.test/a.b",
        ]);

        expect(new Set(ids).size).toBe(3);
        expect(ids[0]).not.toBe(ids[1]);
    });

    test("one id per uri, in order", () => {
        const uris = ["https://a.test/", "https://b.test/", "https://c.test/"];

        expect(siteAnchors(uris)).toHaveLength(3);
        expect(siteAnchors(uris)[1]).toContain("b-test");
    });

    test("a url that slugifies to nothing still gets a usable id", () => {
        expect(siteAnchorId("https://")).toMatch(/^site-[A-Za-z0-9-]+$/);
    });

    test("labels drop the scheme and the trailing slash", () => {
        expect(siteLabel("https://onionfarms.com/")).toBe("onionfarms.com");
        expect(siteLabel("https://onionfarms.com/chatbox")).toBe("onionfarms.com/chatbox");
    });

    test("a label falls back to the raw value rather than throwing", () => {
        expect(siteLabel("not a url")).toBe("not a url");
    });
});
