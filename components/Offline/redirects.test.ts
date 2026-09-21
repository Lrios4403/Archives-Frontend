/*
 * Redirects with a body are shown, not skipped — when asked.
 *
 * The rule under test (view.ts, findNearestRecord + NearestOptions): a walk
 * follows every 3xx it meets, EXCEPT that a caller who passes
 * `stopAtBodiedRedirect` gets handed the first redirect that carries a body,
 * with `redirectsTo` naming where it would have gone. Nothing changes for a
 * caller who does not pass it — which is every subresource lookup — so the
 * first test here is that the default is exactly what it was.
 *
 * Fixtures follow revisit.test.ts: real WarcRecord objects pushed through the
 * real index, so a change to lookupKeys or nearestCapture is caught here too.
 */
import { describe, expect, test } from "bun:test";
import { createRecordEntries, pushRecord } from "./records";
import { findNearestRecord } from "./view";
import type { WarcFileHande, WarcRecord } from "./types";

const ARCHIVE = { name: "site.warc", size: 64, parsedOffset: 0, file: new File([new Uint8Array(64)], "site.warc") } as WarcFileHande;
const AT = "2026-01-01T00:00:00Z";

interface Init {
    url: string;
    status?: number;
    location?: string | null;
    /** Body bytes. 0 is the ordinary header-only redirect. */
    body?: number;
}

const record = ({ url, status = 200, location = null, body = 32 }: Init): WarcRecord => ({
    uuid: `${url}@${AT}`,
    url,
    dateArchived: new Date(AT),
    lastArchived: new Date(AT),
    contentType: "text/html",
    fileHandle: ARCHIVE,
    customId: `${ARCHIVE.name}::${url}::${AT}`,
    type: "response",
    offset: 0,
    length: 0,
    ip: null,
    concurrentTo: null,
    refersTo: null,
    digest: null,
    refersToUri: null,
    refersToDate: null,
    truncated: null,
    http: {
        version: "HTTP/1.1", status, statusText: "", location,
        contentType: "text/html", contentLength: body, contentEncoding: null,
        transferEncoding: null, lastModified: null, headers: {}, headerOffset: 0,
    } as WarcRecord["http"],
    payload: body > 0
        ? { offset: 100, size: body, digest: null, fullSize: body } as WarcRecord["payload"]
        : null,
});

const store = (...records: WarcRecord[]) => {
    const entries = createRecordEntries();
    for (const one of records) pushRecord(one, entries);
    return entries;
};

// garden.html -> garden, the neocities shape: a 301 that also serves a page.
const bodied = record({ url: "https://site/garden.html", status: 301, location: "garden", body: 512 });
const gardenPage = record({ url: "https://site/garden" });

// The ordinary shape: headers and nothing else.
const bare = record({ url: "https://site/old", status: 301, location: "/new", body: 0 });
const newPage = record({ url: "https://site/new" });

// nginx's "301 Moved Permanently … <center>openresty</center>": 166 bytes of
// server boilerplate, which is what most of the archive's bodied redirects are
// (92% under 256 B). The rule is literal — ANY body — so this is shown too. The
// owner's choice, made knowing that number; see REDIRECT_BODY_MIN_BYTES.
const stub = record({ url: "https://site/ohayo.html", status: 301, location: "ohayo", body: 166 });
const ohayoPage = record({ url: "https://site/ohayo" });

// A bare hop INTO the bodied one.
const hop = record({ url: "https://site/entry", status: 302, location: "/garden.html", body: 0 });

describe("bodied redirects", () => {
    test("by default a redirect with a body is followed like any other", () => {
        const found = findNearestRecord(store(bodied, gardenPage), "https://site/garden.html", AT);

        expect(found.record?.url).toBe("https://site/garden");
        expect(found.redirects).toEqual(["https://site/garden"]);
        expect(found.redirectsTo).toBeUndefined();
    });

    test("with stopAtBodiedRedirect, the redirect itself is the answer and says where it goes", () => {
        const found = findNearestRecord(store(bodied, gardenPage), "https://site/garden.html", AT, {
            stopAtBodiedRedirect: true,
        });

        expect(found.record?.url).toBe("https://site/garden.html");
        expect(found.redirects).toEqual([]);
        expect(found.redirectsTo).toBe("https://site/garden");
    });

    test("a 166-byte server stub is still a body: shown, with where it goes", () => {
        const found = findNearestRecord(store(stub, ohayoPage), "https://site/ohayo.html", AT, {
            stopAtBodiedRedirect: true,
        });

        expect(found.record?.url).toBe("https://site/ohayo.html");
        expect(found.redirects).toEqual([]);
        expect(found.redirectsTo).toBe("https://site/ohayo");
    });

    test("…and without the option the same stub is followed, as every subresource lookup expects", () => {
        const found = findNearestRecord(store(stub, ohayoPage), "https://site/ohayo.html", AT);

        expect(found.record?.url).toBe("https://site/ohayo");
        expect(found.redirectsTo).toBeUndefined();
    });

    test("a header-only redirect is still followed even when asked to stop", () => {
        const found = findNearestRecord(store(bare, newPage), "https://site/old", AT, { stopAtBodiedRedirect: true });

        expect(found.record?.url).toBe("https://site/new");
        expect(found.redirectsTo).toBeUndefined();
    });

    test("a chain walks through bare hops and stops at the first bodied one, reporting both", () => {
        const found = findNearestRecord(store(hop, bodied, gardenPage), "https://site/entry", AT, {
            stopAtBodiedRedirect: true,
        });

        expect(found.record?.url).toBe("https://site/garden.html");
        // The hop that WAS walked is still on record; the one that was not is in redirectsTo.
        expect(found.redirects).toEqual(["https://site/garden.html"]);
        expect(found.redirectsTo).toBe("https://site/garden");
    });

    test("a bodied redirect whose destination is missing is still shown, not failed", () => {
        const found = findNearestRecord(store(bodied), "https://site/garden.html", AT, { stopAtBodiedRedirect: true });

        // The reader gets the page that exists; where it points is for the bar to say.
        expect(found.record?.url).toBe("https://site/garden.html");
        expect(found.redirectsTo).toBe("https://site/garden");
    });
});
