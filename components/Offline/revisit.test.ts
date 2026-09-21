// bun test components/Offline/revisit.test.ts
//
// A revisit record says "this url was re-crawled and the body is unchanged": it
// stores the HTTP headers and no body, and names its bytes by payload digest.
// Before this, nearestCapture filtered on `type === 'response'`, so a url captured
// only as a revisit reported "captured with no body" while the bytes sat in the
// same container — 329 records in the WACZ on hand, 4.5% of it.
//
// Measured on that archive, which is what the numbers below encode:
//   within ONE of its four archives   19% of revisits resolve
//   across the whole container       329/329, by digest and by refers-to alike
// So resolution has to go through the cross-file index, and these tests use
// records from two different files to keep that honest.

import { describe, expect, test } from "bun:test";
import { createRecordEntries, pushRecord } from "./records";
import { findNearestRecord } from "./view";
import type { WarcFileHande, WarcRecord } from "./types";

const fileHandle = (name: string): WarcFileHande =>
    ({ name, size: 64, parsedOffset: 0, file: new File([new Uint8Array(64)], name) } as WarcFileHande);

const ARCHIVE_A = fileHandle("rec-a.warc.gz");
const ARCHIVE_B = fileHandle("rec-b.warc.gz");

interface Init {
    url: string;
    type?: WarcRecord["type"];
    at: string;
    digest?: string | null;
    refersToUri?: string | null;
    refersToDate?: string | null;
    handle?: WarcFileHande;
    payload?: boolean;
    contentType?: string;
}

/**
 * `contentType` defaults to EMPTY for a body-less record, because that is what
 * the parser actually produces.
 *
 * mwarc only walks an HTTP header block for `response`, so a revisit arrives with
 * `http: null`, and wire.ts derives contentType from that header — giving `''`.
 * The fixture said "text/html" at first and the donor-inheritance test failed
 * against correct code: a revisit that already has a type keeps it, and the
 * fixture had handed it one it would never have in practice.
 */
const record = ({
    url,
    type = "response",
    at,
    digest = null,
    refersToUri = null,
    refersToDate = null,
    handle = ARCHIVE_A,
    payload = true,
    contentType = payload ? "text/html" : "",
}: Init): WarcRecord => ({
    uuid: `${url}@${at}`,
    url,
    dateArchived: new Date(at),
    lastArchived: new Date(at),
    contentType,
    fileHandle: handle,
    customId: `${handle.name}::${url}::${at}`,
    type,
    offset: 0,
    length: 0,
    ip: null,
    concurrentTo: null,
    refersTo: null,
    digest,
    refersToUri,
    refersToDate,
    truncated: null,
    http: payload
        ? {
            version: "HTTP/1.1", status: 200, statusText: "OK", location: null,
            contentType, contentLength: 32, contentEncoding: null,
            transferEncoding: null, lastModified: null, headers: {}, headerOffset: 0,
        } as WarcRecord["http"]
        : null,
    payload: payload
        ? { offset: 100, size: 32, digest, fullSize: 32 } as WarcRecord["payload"]
        : null,
});

const store = (...records: WarcRecord[]) => {
    const entries = createRecordEntries();
    for (const one of records) pushRecord(one, entries);
    return entries;
};

const DIGEST = "sha256:aaaabbbbcccc";

describe("revisit resolution", () => {
    test("a revisit resolves to the donor's bytes, across files", () => {
        const donor = record({
            url: "https://site/original.png", at: "2026-01-01T00:00:00Z",
            digest: DIGEST, handle: ARCHIVE_A, contentType: "image/png",
        });
        const revisit = record({
            url: "https://site/copy.png", at: "2026-06-01T00:00:00Z", type: "revisit",
            digest: DIGEST, handle: ARCHIVE_B, payload: false,
        });

        const found = findNearestRecord(store(donor, revisit), "https://site/copy.png", revisit.dateArchived.toISOString());

        expect(found.record).not.toBeNull();
        // The donor's bytes...
        expect(found.record!.payload).toEqual(donor.payload);
        // ...from the donor's FILE, which is a different archive.
        expect(found.record!.fileHandle.name).toBe("rec-a.warc.gz");
        // ...and the donor's type, since mwarc parses no HTTP block for a revisit.
        expect(found.record!.contentType).toBe("image/png");
    });

    // The identity must stay the revisit's. Returning the donor itself would be
    // simpler and wrong: deduplication is by BYTES, so the donor is routinely a
    // different url, and the reader would be shown a page they did not click on.
    test("the resolved record keeps the revisit's own url and date", () => {
        const donor = record({ url: "https://site/original.png", at: "2026-01-01T00:00:00Z", digest: DIGEST });
        const revisit = record({
            url: "https://site/copy.png", at: "2026-06-01T00:00:00Z", type: "revisit",
            digest: DIGEST, handle: ARCHIVE_B, payload: false,
        });

        const found = findNearestRecord(store(donor, revisit), "https://site/copy.png", revisit.dateArchived.toISOString());

        expect(found.record!.url).toBe("https://site/copy.png");
        expect(found.record!.dateArchived.toISOString()).toBe("2026-06-01T00:00:00.000Z");
        expect(found.record!.type).toBe("revisit");
    });

    test("falls back to Refers-To-Target-URI when there is no digest", () => {
        const donor = record({ url: "https://site/original.png", at: "2026-01-01T00:00:00Z", digest: null });
        const revisit = record({
            url: "https://site/copy.png", at: "2026-06-01T00:00:00Z", type: "revisit",
            digest: null, refersToUri: "https://site/original.png",
            refersToDate: "2026-01-01T00:00:00Z", handle: ARCHIVE_B, payload: false,
        });

        const found = findNearestRecord(store(donor, revisit), "https://site/copy.png", revisit.dateArchived.toISOString());

        expect(found.record).not.toBeNull();
        expect(found.record!.payload).toEqual(donor.payload);
    });

    test("picks the donor archived nearest the revisit", () => {
        const near = record({ url: "https://site/a", at: "2026-05-01T00:00:00Z", digest: DIGEST });
        const far = record({ url: "https://site/b", at: "2020-01-01T00:00:00Z", digest: DIGEST });
        const revisit = record({
            url: "https://site/copy", at: "2026-06-01T00:00:00Z", type: "revisit",
            digest: DIGEST, handle: ARCHIVE_B, payload: false,
        });

        const found = findNearestRecord(store(far, near, revisit), "https://site/copy", revisit.dateArchived.toISOString());

        expect(found.record!.payload!.offset).toBe(near.payload!.offset);
        expect(found.record!.customId).toBe(revisit.customId);
    });

    // The honest answer when only part of a container is loaded. It must be a clean
    // "no payload", not a record that renders blank.
    test("an unresolvable revisit reports no-payload rather than resolving wrongly", () => {
        const revisit = record({
            url: "https://site/copy.png", at: "2026-06-01T00:00:00Z", type: "revisit",
            digest: "sha256:nothing-has-this", handle: ARCHIVE_B, payload: false,
        });

        const found = findNearestRecord(store(revisit), "https://site/copy.png", revisit.dateArchived.toISOString());

        expect(found.record).toBeNull();
        expect(found.reason).toBe("no-payload");
    });

    // Donors only in the digest index, so a revisit can never resolve to another
    // revisit — which is what keeps the lookup one step and cycle-free.
    test("a revisit is never itself a donor", () => {
        const first = record({
            url: "https://site/one", at: "2026-01-01T00:00:00Z", type: "revisit",
            digest: DIGEST, payload: false,
        });
        const second = record({
            url: "https://site/two", at: "2026-02-01T00:00:00Z", type: "revisit",
            digest: DIGEST, handle: ARCHIVE_B, payload: false,
        });

        const entries = store(first, second);

        expect(entries.recordsDigestMap.get(DIGEST)).toBeUndefined();
        expect(findNearestRecord(entries, "https://site/two", second.dateArchived.toISOString()).record).toBeNull();
    });

    // Precedence, the other way round: a revisit that DOES carry its own type
    // keeps it. Only reachable if the parser learns to read a revisit's HTTP
    // block, which it does not today — hence the explicit fixture override.
    test("a revisit's own content type wins over the donor's", () => {
        const donor = record({ url: "https://site/original", at: "2026-01-01T00:00:00Z", digest: DIGEST, contentType: "image/png" });
        const revisit = record({
            url: "https://site/copy", at: "2026-06-01T00:00:00Z", type: "revisit",
            digest: DIGEST, handle: ARCHIVE_B, payload: false, contentType: "image/webp",
        });

        const found = findNearestRecord(store(donor, revisit), "https://site/copy", revisit.dateArchived.toISOString());

        expect(found.record!.contentType).toBe("image/webp");
    });

    test("plain responses are unaffected", () => {
        const plain = record({ url: "https://site/page", at: "2026-01-01T00:00:00Z", digest: "sha256:x" });
        const found = findNearestRecord(store(plain), "https://site/page", plain.dateArchived.toISOString());

        expect(found.record).toBe(plain);
    });
});

describe("crawler metadata records", () => {
    // All 123 `resource` records in the WACZ are urn:pageinfo: JSON written by
    // Browsertrix — crawler bookkeeping, not archived content. They must not appear
    // as browsable pages. Already true via pushRecordIntoTree; asserted so it stays
    // true.
    test("urn: records are kept out of both trees", () => {
        const pageinfo = record({
            url: "urn:pageinfo:https://site/", type: "resource",
            at: "2026-01-01T00:00:00Z", contentType: "application/json",
        });

        const entries = store(pageinfo);

        expect(entries.recordTree.length).toBe(0);
        expect(entries.normalTree.length).toBe(0);
        expect(entries.untreedRecords).toContain(pageinfo);
        // Still kept — it is real data, just not a page.
        expect(entries.records).toContain(pageinfo);
    });

    test("a normal url still reaches both trees", () => {
        const entries = store(record({ url: "https://site/page", at: "2026-01-01T00:00:00Z" }));

        expect(entries.recordTree.length).toBe(1);
        expect(entries.normalTree.length).toBe(1);
        expect(entries.untreedRecords.length).toBe(0);
    });
});
