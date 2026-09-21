'use client';

/**
 * Fixtures for the offline viewer.
 *
 * Split out of types.ts, which every Offline component imports: these 300-odd
 * lines of sample records — and a File allocated at module scope — were being
 * pulled into the bundle and evaluated on load whether or not anything wanted
 * them. Nothing here is reachable unless USE_EXAMPLE_DATA is on or a test asks
 * for it directly.
 */

import {
    WarcFileHande,
    WarcRecord,
    WarcRecordEntries,
    WarcRecordTreeNode,
    WarcRecordType,
} from "./types";
import { createRecordEntries, pushRecord } from "./records";

// ---------------------------------------------------------------------------
// Example data
//
// Fixtures for building the offline viewer's UI before the browser parser at
// /api/warc/parser.js exists. They cover the cases that are easy to get wrong
// once real records arrive: a URL captured twice, a revisit record with no body
// of its own, a redirect carrying a relative Location, a chunked payload, a
// truncated one, a 404, and an intermediate tree node holding no records.
//
// Set USE_EXAMPLE_DATA to false to get the empty context back. Picking real
// files clears the example file handle (setFileHandles empties the array), but
// the example records stay in recordEntries until reload, since nothing resets
// the record store yet.
// ---------------------------------------------------------------------------

export const USE_EXAMPLE_DATA = false;

const EXAMPLE_FILE_SIZE = 4096;

/**
 * Deterministic filler bytes. The offsets on the fixtures below are plausible
 * but do not index into a real WARC, so this is the right *number* of bytes
 * rather than any record's actual body — enough to exercise slicing and any
 * loading state built on it.
 */
// Backed by an explicit ArrayBuffer so the type is Uint8Array<ArrayBuffer>. A
// bare `new Uint8Array(n)` is Uint8Array<ArrayBufferLike>, which since TS 5.7
// also admits SharedArrayBuffer and so is not a BlobPart — the File constructor
// below rejects it.
const exampleBytes = (): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(new ArrayBuffer(EXAMPLE_FILE_SIZE));
    for (let i = 0; i < out.length; i++) out[i] = 0x41 + (i % 26);
    return out;
};

/**
 * A real File, not a stub with a read function — the fixture has to be the same
 * shape as an uploaded handle or it would not survive being posted to a worker,
 * which is exactly the bug this replaced.
 */
export const exampleFileHandle: WarcFileHande = {
    size: EXAMPLE_FILE_SIZE,
    parsedOffset: EXAMPLE_FILE_SIZE,
    name: 'example.warc',
    status: 'parsed',
    file: new File([exampleBytes()], 'example.warc', { type: 'application/warc' }),
};

interface ExampleRecordInit {
    url: string;
    uuid: string;
    offset: number;
    contentType?: string;
    status?: number;
    statusText?: string;
    location?: string | null;
    lastModified?: Date | null;
    dateArchived?: Date;
    lastArchived?: Date;
    type?: WarcRecordType;
    truncated?: string | null;
    /** Set to make the payload chunked; the fixture derives fullSize from these. */
    chunks?: number[];
    payloadSize?: number;
    /** False for records that defer their body to another one, e.g. a revisit. */
    hasPayload?: boolean;
    concurrentTo?: string | null;
    refersTo?: string | null;
    headers?: Record<string, string>;
}

const EXAMPLE_CRAWL = new Date('2026-02-11T09:14:03.000Z');
const EXAMPLE_RECRAWL = new Date('2026-07-30T22:41:57.000Z');

/** Byte sizes of the two header blocks that sit ahead of a payload in this fixture. */
const EXAMPLE_WARC_HEADER_SIZE = 396;
const EXAMPLE_HTTP_HEADER_SIZE = 214;

const exampleRecord = ({
    url,
    uuid,
    offset,
    contentType = 'text/html',
    status = 200,
    statusText = 'OK',
    location = null,
    lastModified = null,
    dateArchived = EXAMPLE_CRAWL,
    lastArchived = EXAMPLE_CRAWL,
    type = 'response',
    truncated = null,
    chunks,
    payloadSize = 512,
    hasPayload = true,
    concurrentTo = null,
    refersTo = null,
    headers = {},
}: ExampleRecordInit): WarcRecord => {
    const headersOffset = offset + EXAMPLE_WARC_HEADER_SIZE;
    const payloadOffset = headersOffset + EXAMPLE_HTTP_HEADER_SIZE;
    const fullContentType = contentType.startsWith('text/') || contentType.endsWith('/javascript')
        ? `${contentType}; charset=utf-8`
        : contentType;

    return {
        uuid,
        url,
        dateArchived,
        lastArchived,
        contentType,
        fileHandle: exampleFileHandle,
        customId: `${exampleFileHandle.name}::${url}::${uuid}`,
        type,
        offset,
        length: EXAMPLE_HTTP_HEADER_SIZE + (hasPayload ? payloadSize : 0),
        ip: '93.184.216.34',
        concurrentTo,
        refersTo,
        // Digest derived from the uuid rather than the bytes: the fixture is not
        // trying to be a real sha, it is trying to give every record a distinct,
        // stable key so the revisit index has something to look up. A revisit
        // fixture wanting to resolve should be given the digest of its donor.
        digest: `sha256:example-${uuid}`,
        refersToUri: null,
        refersToDate: null,
        truncated,
        http: {
            version: 'HTTP/1.1',
            status,
            statusText,
            location,
            contentType: fullContentType,
            // A chunked response sends no Content-Length — that absence is the
            // whole reason payload.size exists, so the fixture honours it.
            contentLength: chunks ? null : payloadSize,
            contentEncoding: null,
            transferEncoding: chunks ? 'chunked' : null,
            lastModified,
            headers: {
                Date: dateArchived.toUTCString(),
                Server: 'nginx/1.24.0',
                'Content-Type': fullContentType,
                ...(chunks ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(payloadSize) }),
                ...(location ? { Location: location } : {}),
                ...(lastModified ? { 'Last-Modified': lastModified.toUTCString() } : {}),
                ...headers,
            },
            headersOffset,
        },
        payload: hasPayload
            ? {
                offset: payloadOffset,
                size: payloadSize,
                chunks,
                fullSize: chunks ? chunks.reduce((total, chunk) => total + chunk, 0) : payloadSize,
                // Synthetic: shaped like a WARC-Payload-Digest, but it is the
                // uuid's hex, not a real hash of anything readHandle returns.
                digest: `sha1:${uuid.replace(/-/g, '').toUpperCase()}`,
            }
            : null,
    };
};

// example.com/ — captured twice. Both carry the same lastArchived (the newer
// capture's date), which is what makes it a per-URL value rather than a
// per-record one.
const exampleHome = exampleRecord({
    url: 'https://example.com/',
    uuid: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f601',
    offset: 0,
    lastArchived: EXAMPLE_RECRAWL,
    lastModified: new Date('2026-01-04T17:22:00.000Z'),
    concurrentTo: 'aaaa1111-2222-4333-8444-555566667701',
});

// The recrawl found the page unchanged, so the crawler wrote a revisit that
// points back at the capture above instead of storing the body again.
const exampleHomeRevisit = exampleRecord({
    url: 'https://example.com/',
    uuid: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f602',
    offset: 1024,
    type: 'revisit',
    dateArchived: EXAMPLE_RECRAWL,
    lastArchived: EXAMPLE_RECRAWL,
    hasPayload: false,
    refersTo: exampleHome.uuid,
});

const exampleAbout = exampleRecord({
    url: 'https://example.com/about',
    uuid: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f603',
    offset: 1536,
    payloadSize: 318,
});

// Relative Location, which is legal and common — resolve it against `url`.
const exampleBlogRedirect = exampleRecord({
    url: 'https://example.com/blog',
    uuid: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f604',
    offset: 2048,
    status: 301,
    statusText: 'Moved Permanently',
    location: '/blog/',
    payloadSize: 0,
});

const exampleBlogPost = exampleRecord({
    url: 'https://example.com/blog/hello-world.html',
    uuid: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f605',
    offset: 2304,
    chunks: [1024, 1024, 337],
    payloadSize: 2417, // encoded length: the three chunks plus their framing
});

const exampleStylesheet = exampleRecord({
    url: 'https://example.com/assets/style.css',
    uuid: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f606',
    offset: 3072,
    contentType: 'text/css',
    payloadSize: 742,
});

// Truncated: payload.size is short of what the server meant to send, so the
// digest will not verify against the stored bytes.
const exampleScript = exampleRecord({
    url: 'https://example.com/assets/app.js',
    uuid: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f607',
    offset: 3584,
    contentType: 'application/javascript',
    truncated: 'length',
    payloadSize: 256,
});

const exampleMissing = exampleRecord({
    url: 'https://example.com/missing',
    uuid: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f608',
    offset: 3840,
    status: 404,
    statusText: 'Not Found',
    payloadSize: 162,
});

export const exampleRecords: WarcRecord[] = [
    exampleHome,
    exampleHomeRevisit,
    exampleAbout,
    exampleBlogRedirect,
    exampleBlogPost,
    exampleStylesheet,
    exampleScript,
    exampleMissing,
];

// The tree the real builder should produce for exampleRecords. Written out by
// hand rather than derived, so it stays a fixed expectation to build against:
// note `assets`, which holds no records of its own because nothing ever
// captured the directory itself.
//
// Siblings are in A-Z order by segment, which is NOT the order the records
// above are declared in — the builder inserts each node in sorted position, so
// `assets` sits between `about` and `blog` and `app.js` precedes `style.css`
// even though both arrived the other way round. Keeping the fixture in built
// order is what lets it be compared against the builder's output directly.
export const exampleRecordTree: WarcRecordTreeNode[] = [
    {
        segment: 'example.com',
        url: 'https://example.com/',
        records: [exampleHome, exampleHomeRevisit],
        children: [
            {
                segment: 'about',
                url: 'https://example.com/about',
                records: [exampleAbout],
                children: [],
            },
            {
                segment: 'assets',
                url: 'https://example.com/assets',
                records: [],
                children: [
                    {
                        segment: 'app.js',
                        url: 'https://example.com/assets/app.js',
                        records: [exampleScript],
                        children: [],
                    },
                    {
                        segment: 'style.css',
                        url: 'https://example.com/assets/style.css',
                        records: [exampleStylesheet],
                        children: [],
                    },
                ],
            },
            {
                segment: 'blog',
                url: 'https://example.com/blog',
                records: [exampleBlogRedirect],
                children: [
                    {
                        segment: 'hello-world.html',
                        url: 'https://example.com/blog/hello-world.html',
                        records: [exampleBlogPost],
                        children: [],
                    },
                ],
            },
            {
                segment: 'missing',
                url: 'https://example.com/missing',
                records: [exampleMissing],
                children: [],
            },
        ],
    },
];

/**
 * Fresh, mutable entries seeded with exampleRecords. Built through pushRecord
 * rather than a literal so the fixture's recordsUrlMap is grouped by exactly
 * the rule production uses — and so the context gets its own copies, leaving
 * exampleRecords untouched when parsing pushes real records in.
 */
export const createExampleRecordEntries = (): WarcRecordEntries => {
    // The shared factory, so a new field on WarcRecordEntries reaches here too.
    // This was its own literal, and adding seenRecordIds broke it immediately.
    const entries: WarcRecordEntries = createRecordEntries();

    exampleRecords.forEach(record => pushRecord(record, entries));

    return entries;
};

// The context value itself is assembled by createWarcRecordStore in store.ts,
// per provider mount. It used to be a module-level constant here, which is why
// mutating it never re-rendered anything: React compares the provider's `value`
// by identity, and a singleton's identity never changes.
