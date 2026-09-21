'use client';

/**
 * Translating what the parse worker posts into what the UI reads.
 *
 * The worker speaks WireWarcRecord — raw header bags keyed exactly as they
 * appeared in the file. WarcRecord is normalised: real Dates, a nested http
 * block, an essence-only content type. This module is the seam between them and
 * the only place that knows both shapes.
 */

import { WarcFileHande, WarcGzipLocation, WarcHttpInfo, WarcRecord } from "./types";

/**
 * What the parse worker posts: mwarc's own output with the payload bytes
 * stripped. Header bags are keyed exactly as they appeared in the file.
 */
export interface WireWarcRecord {
    type: string;
    /** WARC-Target-URI, already unwrapped by the worker. */
    url?: string;
    offset: number;
    warc: Record<string, string | number>;
    http?: Record<string, string | number>;
    payload?: {
        offset: number;
        size: number;
        fullSize?: number;
        chunks?: number[];
        chunked: boolean;
        /** Set by the worker for a .warc.gz. See WarcGzipLocation. */
        gzip?: WarcGzipLocation;
    };
    status?: number;
}

/** Case-insensitive header lookup — crawlers do not agree on casing. */
const header = (bag: Record<string, string | number> | undefined, name: string): string | null => {
    if (!bag) return null;

    const wanted = name.toLowerCase();

    for (const key of Object.keys(bag)) {
        if (key.toLowerCase() === wanted) {
            const value = bag[key];
            return value === undefined || value === null ? null : String(value);
        }
    }

    return null;
};

const numberOrNull = (value: string | null): number | null => {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const dateOrNull = (value: string | null): Date | null => {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** "<urn:uuid:xxxx>" -> "xxxx". Returns the raw value if it is not wrapped. */
const uuidFromRecordId = (raw: string | null): string => {
    if (!raw) return '';
    return /<urn:uuid:([^>]+)>/i.exec(raw)?.[1] ?? raw;
};

/**
 * "<http://example.com/>" -> "http://example.com/".
 *
 * The worker already does this, so this is a fallback for one specific case: the
 * parser bundle is fetched over HTTP and cached, so a browser holding an older
 * copy would still be sending wrapped urls. Cheap enough to just always apply.
 */
const unwrapAngleBrackets = (raw: string | null): string => {
    if (!raw) return '';
    const value = raw.trim();
    return (/^<(.+)>$/.exec(value)?.[1]?.trim() ?? value) || '';
};

/**
 * The url a record is stored and looked up under, in ONE canonical spelling.
 *
 * This is the key of recordsUrlMap, and the viewer looks records up with urls it
 * built by resolving a page's references: `new URL(href, base).href`. That
 * normalises — a bare origin gains a trailing slash, the host is lowercased,
 * percent-escapes are canonicalised — and the raw WARC-Target-URI does not. So a
 * record the crawler stored as "https://about.youtube" could never be found by a
 * lookup for "https://about.youtube/", and a page's whole asset list came back
 * empty while the records sat right there in the map.
 *
 * Normalising HERE rather than at every lookup means both sides are produced by
 * the same function and agree by construction, instead of by a growing list of
 * fallback spellings that has to anticipate every difference.
 *
 * Unparseable urls are kept verbatim. dns: and urn: targets are real records that
 * simply are not web addresses, and mangling them would lose information for no
 * gain — nothing will ever look them up.
 */
const normalizeUrl = (raw: string): string => {
    if (!raw) return '';

    try {
        return new URL(raw).href;
    } catch {
        return raw;
    }
};

/**
 * Translate a worker record into the shape the UI reads.
 *
 * Everything here comes from the wire record except `fileHandle`, which the
 * worker cannot know (it was posted a File, not the handle), and `lastArchived`,
 * which is a property of a URL across every loaded file rather than of one
 * record — both are main-thread facts, which is why this mapping lives here and
 * not in the worker.
 *
 * It used to take the record store as a third argument and never look at it;
 * lastArchived is reconciled by pushRecord, not here.
 */
export const toWarcRecord = (
    wire: WireWarcRecord,
    fileHandle: WarcFileHande,
): WarcRecord => {
    // Prefer the worker's normalised field; fall back to unwrapping the raw
    // header ourselves, which covers a browser still running a cached bundle
    // from before the worker learned to do it.
    const url = normalizeUrl(wire.url ?? unwrapAngleBrackets(header(wire.warc, 'WARC-Target-URI')));
    const uuid = uuidFromRecordId(header(wire.warc, 'WARC-Record-ID'));
    const dateArchived = dateOrNull(header(wire.warc, 'WARC-Date')) ?? new Date(0);

    const fullContentType = header(wire.http, 'Content-Type');

    const http: WarcHttpInfo | null = wire.http
        ? {
            version: String(wire.http['httpVersion'] ?? ''),
            status: wire.status ?? numberOrNull(header(wire.http, 'statusCode')),
            statusText: String(wire.http['statusText'] ?? ''),
            location: header(wire.http, 'Location'),
            // Parameters preserved, whitespace normalised.
            contentType: fullContentType ? fullContentType.split(';').map(part => part.trim()).join('; ') : null,
            contentLength: numberOrNull(header(wire.http, 'Content-Length')),
            contentEncoding: header(wire.http, 'Content-Encoding'),
            transferEncoding: header(wire.http, 'Transfer-Encoding'),
            lastModified: dateOrNull(header(wire.http, 'Last-Modified')),
            headers: Object.fromEntries(
                Object.entries(wire.http).map(([key, value]) => [key, String(value)]),
            ),
            headersOffset: Number(wire.http['offset'] ?? 0),
        }
        : null;

    return {
        uuid,
        url,
        dateArchived,
        // Provisional: pushRecord reconciles this across every capture of the
        // url once the record joins the group.
        lastArchived: dateArchived,
        // Essence type only, lowercased — the grouping key.
        contentType: (fullContentType ?? '').split(';')[0]!.trim().toLowerCase(),
        fileHandle,
        customId: `${fileHandle.name}::${url}::${uuid}`,
        type: wire.type,
        offset: wire.offset,
        length: numberOrNull(header(wire.warc, 'Content-Length')) ?? 0,
        ip: header(wire.warc, 'WARC-IP-Address'),
        concurrentTo: header(wire.warc, 'WARC-Concurrent-To'),
        refersTo: header(wire.warc, 'WARC-Refers-To'),
        // Lifted out of the payload block on purpose: a revisit HAS no payload
        // block, and a revisit is precisely the record whose digest has to be
        // looked up. See WarcRecord.digest.
        digest: header(wire.warc, 'WARC-Payload-Digest'),
        refersToUri: unwrapAngleBrackets(header(wire.warc, 'WARC-Refers-To-Target-URI')) || null,
        refersToDate: header(wire.warc, 'WARC-Refers-To-Date'),
        truncated: header(wire.warc, 'WARC-Truncated'),
        http,
        payload: wire.payload
            ? {
                offset: wire.payload.offset,
                size: wire.payload.size,
                chunks: wire.payload.chunks,
                fullSize: wire.payload.fullSize,
                digest: header(wire.warc, 'WARC-Payload-Digest'),
                // Relayed untouched. This module is the only one that knows both
                // shapes, so a field missed here is a field the view worker never
                // sees — and for a .warc.gz that means it reads compressed bytes
                // from a logical offset and renders them as a document.
                gzip: wire.payload.gzip,
            }
            : null,
    };
};
