// bun test components/Offline/wire.test.ts
//
// wire.ts is the only module that knows both the worker's shape and the UI's, so
// a field it forgets to copy is a field that silently does not exist downstream.
// For `payload.gzip` that failure is invisible until a page renders as binary —
// the view worker reads a compressed file at a logical offset, gets bytes, and
// hands them to an iframe.
//
// These tests are about the RELAY, not about gzip: the frontend never interprets
// the location, so what matters is only that it arrives unchanged.
//
// Run with bun, from frontend/:  bun test components/Offline/wire.test.ts
//
// `**/*.test.ts` is excluded in tsconfig.json, because `bun:test` has no types
// without @types/bun and adding those to a Next app pulls Bun's globals in
// alongside the DOM lib. The trade is that this file is run but not type-checked;
// `next build` would otherwise fail on the import above.

import { describe, expect, test } from "bun:test";
import { toWarcRecord, type WireWarcRecord } from "./wire";
import { toPostedRecord } from "./view";
import type { WarcFileHande, WarcGzipLocation, WarcRecord } from "./types";

const handle = {
    name: "test.warc.gz",
    size: 1000,
    parsedOffset: 0,
    file: new File([new Uint8Array(4)], "test.warc.gz"),
} as WarcFileHande;

const location: WarcGzipLocation = {
    compressedOffset: 409_645_404,
    compressedLength: 2_021_618,
    payloadOffsetInMember: 391,
};

const wireRecord = (payload?: WireWarcRecord["payload"]): WireWarcRecord => ({
    type: "response",
    url: "http://example.com/a",
    offset: 120_430,
    warc: {
        "WARC-Type": "response",
        "WARC-Target-URI": "http://example.com/a",
        "WARC-Record-ID": "<urn:uuid:2f4e1a30-0000-4000-8000-000000000001>",
        "WARC-Date": "2026-06-22T22:16:51.890Z",
        "WARC-Payload-Digest": "sha1:3I42H3S6NNFQ2MSVX7XZKYAYSCX5QBYJ",
        "Content-Length": "84932",
    },
    http: { httpVersion: "HTTP/1.1", statusCode: "200", "Content-Type": "text/html; charset=utf-8" },
    status: 200,
    payload,
});

describe("toWarcRecord payload relay", () => {
    test("relays payload.gzip unchanged", () => {
        const record = toWarcRecord(
            wireRecord({ offset: 120_821, size: 84_932, chunked: false, gzip: location }),
            handle,
        );

        expect(record.payload).not.toBeNull();
        expect(record.payload!.gzip).toEqual(location);
    });

    test("leaves gzip undefined for a plain archive", () => {
        const record = toWarcRecord(
            wireRecord({ offset: 120_821, size: 84_932, chunked: false }),
            handle,
        );

        expect(record.payload!.gzip).toBeUndefined();
    });

    // The other payload fields, so a future edit to this block cannot quietly
    // drop one of them either.
    test("carries the rest of the payload block", () => {
        const record = toWarcRecord(
            wireRecord({
                offset: 120_821,
                size: 84_932,
                fullSize: 84_900,
                chunks: [1024, 2048],
                chunked: true,
                gzip: location,
            }),
            handle,
        );

        expect(record.payload).toEqual({
            offset: 120_821,
            size: 84_932,
            fullSize: 84_900,
            chunks: [1024, 2048],
            digest: "sha1:3I42H3S6NNFQ2MSVX7XZKYAYSCX5QBYJ",
            gzip: location,
        });
    });

    test("a record with no payload relays null", () => {
        expect(toWarcRecord(wireRecord(undefined), handle).payload).toBeNull();
    });

    // The location crosses postMessage on the way in and again on the way back to
    // the view worker, so it has to be plain cloneable data at this hop too.
    test("the relayed location survives structuredClone", () => {
        const record = toWarcRecord(
            wireRecord({ offset: 1, size: 2, chunked: false, gzip: location }),
            handle,
        );

        expect(structuredClone(record.payload!.gzip)).toEqual(location);
    });
});

// The OUTBOUND hop, which is a separate function and was separately broken.
//
// toPostedRecord rebuilds the payload block field by field rather than spreading
// it, so omitting one does not fail to compile — it silently does not reach the
// view worker. `gzip` was missing exactly this way when .warc.gz support first
// landed, and every reader-level test still passed, because the reader was fine;
// the location just never got to it.
describe("toPostedRecord payload relay", () => {
    const withPayload = (payload: WarcRecord["payload"]): WarcRecord => ({
        url: "http://example.com/a",
        contentType: "text/html",
        dateArchived: new Date(0),
        uuid: "2f4e1a30-0000-4000-8000-000000000001",
        fileHandle: handle,
        payload,
        http: {
            version: "HTTP/1.1",
            status: 200,
            statusText: "OK",
            location: null,
            contentType: "text/html; charset=utf-8",
            contentLength: 84_932,
            contentEncoding: "gzip",
            lastModified: null,
            headers: {},
            headerOffset: 0,
        },
    } as unknown as WarcRecord);

    test("relays payload.gzip to the worker", () => {
        const posted = toPostedRecord(withPayload({
            offset: 120_821,
            size: 84_932,
            digest: null,
            gzip: location,
        } as WarcRecord["payload"]));

        expect(posted.payload!.gzip).toEqual(location);
    });

    test("relays the whole payload block", () => {
        const posted = toPostedRecord(withPayload({
            offset: 120_821,
            size: 84_932,
            chunks: [1024, 2048],
            digest: "sha1:abc",
            gzip: location,
        } as WarcRecord["payload"]));

        expect(posted.payload).toEqual({
            offset: 120_821,
            size: 84_932,
            chunks: [1024, 2048],
            digest: "sha1:abc",
            gzip: location,
        });
    });

    test("leaves gzip undefined for a plain archive", () => {
        const posted = toPostedRecord(withPayload({
            offset: 1,
            size: 2,
            digest: null,
        } as WarcRecord["payload"]));

        expect(posted.payload!.gzip).toBeUndefined();
    });

    // Needed for the Content-Encoding decode in the parser's readPayload; the
    // worker cannot derive it, because the posted record carries no headers.
    test("relays Content-Encoding", () => {
        const posted = toPostedRecord(withPayload({
            offset: 1,
            size: 2,
            digest: null,
        } as WarcRecord["payload"]));

        expect(posted.contentEncoding).toBe("gzip");
    });

    test("the posted record survives structuredClone", () => {
        const posted = structuredClone(toPostedRecord(withPayload({
            offset: 1,
            size: 2,
            digest: null,
            gzip: location,
        } as WarcRecord["payload"])));

        expect(posted.payload!.gzip).toEqual(location);
        expect(posted.contentEncoding).toBe("gzip");
    });
});
