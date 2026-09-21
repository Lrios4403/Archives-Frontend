import type { WarcNoticeStore } from "./notices";
import type { WarcDownloadStore } from "./downloads";
import type { MissingRef, ViewOutcome } from "./view";

export interface WarcRecordTreeNode {
    records: WarcRecord[];
    segment: string;
    url: string;
    children: WarcRecordTreeNode[];
}

export interface WarcWorkerHandle {
    worker: Worker;
    fileHandle?: WarcFileHande;

    /**
     * The segment this worker is parsing, when it is parsing one.
     *
     * Only so an IDLE worker can find the busiest one and ask it for its tail — see
     * requestSteal. Absent for a whole-file task, which has no tail to give: cutting
     * one would need a resync on the receiving side and a second progress slot, and
     * a file small enough not to be segmented finishes before that pays off.
     */
    claim?: { handle: WarcFileHande; index: number };
}

export type WarcParseStatus = 'pending' | 'parsing' | 'parsed' | 'error';

/** Where a parse failed. Mirrors WarcParseStage in backend/parser/worker.entry.ts. */
export type WarcParseStage =
    /** The parser bundle itself could not be fetched — backend down, wrong URL. */
    | 'fetch-parser'
    /** The worker died outright, before or instead of reporting anything. */
    | 'worker'
    /** The posted handle was unusable: no File on it. */
    | 'handle'
    /** mwarc threw partway through the archive. */
    | 'decode';

/**
 * Why a file failed, in enough detail to act on.
 *
 * A bare message string is not enough: "Unexpected end of input" reads the same
 * whether the archive is truncated, the backend served an HTML 404 in place of
 * the parser bundle, or the file was moved on disk mid-parse. The stage tells
 * those apart, and the offset says whether it died immediately or 60 MB in.
 */
export interface WarcParseFailure {
    stage: WarcParseStage;

    /** The error's class name — "WarcParseError", "NotReadableError", "TypeError". */
    errorName: string;

    message: string;

    /** Byte offset the parse had reached. Absent when it never started. */
    offset?: number;

    /** Records successfully parsed before the failure — 0 means it died at the first header. */
    records?: number;
}

/** One progress report about one file. Object-shaped so it can grow without reordering arguments. */
export interface WarcParseProgress {
    offset: number;
    size: number;
    status: WarcParseStatus;

    /**
     * Which segment this report is about, when the file is being parsed by several
     * workers. Absent for the ordinary one-worker case.
     *
     * With it, `offset` stops being the file's position — `segmentAt` is this
     * worker's own, and the file's figure is the sum across segments. See
     * applyProgress.
     */
    segment?: number;
    /** This worker's absolute position inside its own segment. */
    segmentAt?: number;
    message?: string;
    error?: WarcParseFailure | null;
    /** Total records seen so far. Only sent on completion. */
    records?: number;
    /** Of those, WARC-Type: response — the ones the UI actually lists. */
    responses?: number;
}

export type WarcParseProgressCallback = (progress: WarcParseProgress) => void;

/**
 * A selected file and everything known about parsing it.
 *
 * PURE DATA, deliberately — no functions, no Worker, nothing that structured
 * clone rejects. Every WarcRecord holds a reference to its handle, so anything
 * unclonable here makes every record unclonable too, four hops down: a Map of
 * records -> a record -> its fileHandle -> the offending field. That is not a
 * theoretical concern; it is why `postMessage(recordsUrlMap)` used to fail with
 * "()=>{} could not be cloned" even though the map itself is fine.
 *
 * The progress callback lives in a WeakMap in progress.ts instead. See
 * watchProgress there.
 */
export interface WarcFileHande {
    size?: number;
    parsedOffset: number;
    name: string;
    status?: WarcParseStatus;
    message?: string;

    /**
     * Set when status is 'error', null otherwise. Written by progress.ts rather
     * than by the component that renders it, so a failure that happens while
     * nothing is mounted is still on the handle when something mounts later.
     */
    error?: WarcParseFailure | null;

    /** Records parsed, set on completion. */
    records?: number;

    /** Of those, responses. */
    responses?: number;

    // ---- Tuning, posted to the parse worker. All optional; the worker's own
    // defaults apply when unset, so leaving these alone is the supported case.

    /**
     * Bytes the worker reads per `read` call. Worker default 8 KiB.
     *
     * Worth raising only if a profile says the workers are idle waiting on reads.
     * Worth LOWERING for nothing — mwarc's old 1 KiB default is what made them
     * idle. Values far above the size of a WARC + HTTP header block just read
     * bytes that get discarded, since payloads are skipped rather than read.
     */
    chunkSize?: number;

    /** Records the worker accumulates before posting a message. Worker default 256. */
    batchRecords?: number;

    /** Milliseconds before the worker posts a partial batch anyway. Worker default 50. */
    batchMs?: number;

    /**
     * The file itself, NOT a read function.
     *
     * This handle is posted to a parse worker, and structured clone throws
     * DataCloneError on functions — a `readHandle: (start, size) => ...` could
     * never survive the postMessage, which is why parsing never started. A File
     * (or Blob) is cloneable, so the worker receives it and builds its own
     * reader:
     *
     *     const read = (start, size) =>
     *         handle.file.slice(start, start + size).arrayBuffer();
     *
     * The read has to happen inside the worker anyway: mwarc reads in 1 KiB
     * chunks with 64-byte probes for chunk framing, so proxying every read back
     * to the main thread would be roughly a million round trips per gigabyte.
     */
    /**
     * `Blob`, not `File`, because a handle is not always a whole file.
     *
     * A `.wacz` is expanded at selection time into one handle per archive inside
     * it, each backed by `container.slice(dataOffset, dataOffset + size)` — a Blob
     * view over the same bytes, with no copy. That is what lets the existing
     * one-worker-per-handle pool parse a four-archive container on four threads
     * instead of one.
     *
     * A File satisfies Blob, so the ordinary case is unchanged. What is lost is
     * `lastModified`, which only fileKey wanted — see `stamp`.
     */
    file: Blob;

    /**
     * `lastModified` of the file the user actually picked.
     *
     * Carried separately because a Blob slice has no mtime of its own, and the
     * listing needs to tell two same-named selections apart — see fileKey. All the
     * archives expanded out of one container share its stamp, and are distinguished
     * by name instead.
     */
    stamp?: number;

    /**
     * One slot per worker, when several are sharing this file.
     *
     * Absent for the ordinary one-worker case, which keeps `parsedOffset` meaning
     * exactly what it always did.
     *
     * Present, `parsedOffset` becomes a SUM: `Σ (at − start)`, the bytes anyone has
     * finished. Summing raw positions is the obvious mistake and would show a worker
     * starting at 1.2 GB as having already parsed 1.2 GB — the file would open at
     * 75% before any work happened. See progress.ts' applyProgress.
     */
    segments?: WarcFileSegment[];
}

// WARC-Type. The union covers the types in the WARC 1.1 spec; the `string & {}`
// tail keeps autocomplete while still accepting the vendor types some crawlers
// emit, so an unknown type is data we ignore rather than a parse failure.
export type WarcRecordType =
    | 'warcinfo'
    | 'request'
    | 'response'
    | 'resource'
    | 'metadata'
    | 'revisit'
    | 'conversion'
    | 'continuation'
    | (string & {});

/**
 * How many of these records are things the viewer will actually show.
 *
 * A WARC stores a request beside every response, and both carry the same
 * WARC-Target-URI — so a node's raw `records.length` is about double what a
 * reader would call "captures of this page". crystal.cafe.warc is 228 responses
 * and 228 requests; a badge reading "2 records" on a page fetched once is just
 * wrong. Derived rather than kept as a counter on the node: a stored count is
 * one more thing that can drift out of step with the array beside it, and nodes
 * hold a handful of records, so the walk is free.
 */
export const countResponseRecords = (records: WarcRecord[]): number => {
    let count = 0;

    for (const record of records) {
        if (record.type === 'response') count++;
    }

    return count;
};

/**
 * Where a record's body lives inside the WARC file, so it can be read back on
 * demand from WarcFileHande.file instead of being held in memory. Nothing here
 * is the body itself — a browsing session opens tens of thousands of records and
 * only ever renders one.
 */
/**
 * Where a payload's bytes physically are inside a `.warc.gz`.
 *
 * Opaque here. The frontend never reads a field of this — it carries it so the
 * view worker gets it back and can read the payload. Kept structural rather than
 * imported from the parser bundle, which is fetched at runtime rather than
 * compiled against.
 */
export interface WarcGzipLocation {
    /** Offset of the containing gzip member in the compressed file. */
    readonly compressedOffset: number;
    readonly compressedLength: number;
    /** Payload start relative to that member's decoded output. */
    readonly payloadOffsetInMember: number;
}

/**
 * One worker's share of a file being parsed by several.
 *
 * `at` starts at `start` and rises to `end`. `done` is set by the worker's own
 * `parsed` message, and is what the file waits on: a file is complete when every
 * segment says so, not when the first one does.
 */
export interface WarcFileSegment {
    start: number;
    end: number;
    /** How far this worker has got, absolutely. Between start and end. */
    at: number;
    done: boolean;

    /**
     * What this segment alone found.
     *
     * Per segment, because the worker's own counters are per parseStream call — each
     * one starts at zero and counts only its own share. The file's totals are the
     * SUMS of these, for exactly the reason `at` is summed rather than taken: the
     * handle used to assign `handle.records = progress.records`, so a 25-segment
     * parse displayed whichever segment reported last. A 1.6 GB archive with 28,000
     * records read "1,729 records" and called itself complete.
     */
    records: number;
    responses: number;

    /** Set when this segment alone failed. The others keep going. */
    error?: WarcParseFailure | null;
}

export interface WarcPayloadLocation {
    /**
     * Byte offset of the first payload byte within the WARC file.
     *
     * A real file position for a plain `.warc`. When `gzip` is set the archive is
     * compressed and this is LOGICAL ONLY — the offset the body would have in the
     * decompressed archive. Fine to display; slicing the file at it yields
     * compressed bytes and no error.
     */
    offset: number;

    /**
     * Bytes on disk. For a `Transfer-Encoding: chunked` body this is the encoded
     * length — chunk-size lines and their CRLFs included — which is the range to
     * slice out of the file. It is NOT the length of the decoded body.
     */
    size: number;

    /**
     * Decoded size of each chunk, in order, framing excluded. Only present for
     * chunked bodies, and only when the parser ran with `returnChunkSizes`.
     * Lets a range request map a byte range in the decoded body back to the
     * chunks that carry it without walking the framing again.
     */
    chunks?: number[];

    /**
     * Length of the body after de-chunking. Equal to `size` for non-chunked
     * bodies, and undefined when the parser ran without `returnFullSize` —
     * check for undefined before showing it as "the" size.
     */
    fullSize?: number;

    /** WARC-Payload-Digest, e.g. "sha1:3I42H3S6NNFQ2MSVX7XZKYAYSCX5QBYJ". */
    digest: string | null;

    /**
     * Present only when the archive is a `.warc.gz`. Carried, never interpreted —
     * see WarcGzipLocation. Dropping it on the way to the view worker turns every
     * payload from this file into compressed bytes rendered as a document.
     */
    gzip?: WarcGzipLocation;
}

/**
 * The HTTP response captured inside the record. Null on record types that carry
 * no HTTP message at all (warcinfo, metadata, most resource records), which is
 * why this is a nested object rather than flattened onto WarcRecord: one null
 * check beats a dozen independently-nullable fields.
 */
export interface WarcHttpInfo {
    /** "HTTP/1.1" — from the status line, not a header. */
    version: string;

    /** 200, 404, … Null when the status line was malformed enough to not parse. */
    status: number | null;

    /** "OK", "Not Found". Empty string when the server sent no reason phrase. */
    statusText: string;

    /**
     * `Location`, present on 3xx and on the 201s that carry one. Kept as the
     * raw header value: it is legally relative ("/login"), so resolve it
     * against WarcRecord.url before following it — do not assume absolute.
     */
    location: string | null;

    /**
     * Content-Type with parameters preserved but whitespace normalised
     * ("text/html; charset=utf-8"). WarcRecord.contentType holds the bare
     * essence type for grouping and filtering.
     */
    contentType: string | null;

    /**
     * The `Content-Length` header as the server sent it. Advisory only — it
     * disagrees with payload.size for chunked and truncated records, so size
     * the read off payload, never off this.
     */
    contentLength: number | null;

    /** `Content-Encoding` — "gzip", "br", … Null when the body is identity. */
    contentEncoding: string | null;

    /** `Transfer-Encoding`. "chunked" here is what makes payload.chunks meaningful. */
    transferEncoding: string | null;

    /** Parsed `Last-Modified`. Null when absent or unparseable. */
    lastModified: Date | null;

    /**
     * Every response header, keyed as it appeared in the file. Header names are
     * case-insensitive on the wire and crawlers do not agree on casing, so read
     * through the named fields above rather than indexing this directly.
     */
    headers: Record<string, string>;

    /** Byte offset of the HTTP header block within the WARC file. */
    headersOffset: number;
}

export interface WarcRecord {
    uuid: string;
    url: string;
    dateArchived: Date;

    /**
     * Most recent capture of this URL across every loaded file — the same value
     * on every record sharing a url, not a per-record field. Equals
     * dateArchived on the newest capture of a URL.
     */
    lastArchived: Date;

    /**
     * Essence type only ("text/html"), lowercased, parameters stripped. This is
     * the grouping/filter key; http.contentType keeps the full header value.
     */
    contentType: string;
    fileHandle: WarcFileHande;

    /**
     * Stable identity across reloads, mirroring the backend's warc_custom_id:
     * `${fileHandle.name}::${url}::${uuid}`. uuid alone is not enough — the same
     * record id reappears when a file is loaded twice, or in derived WARCs.
     */
    customId: string;

    type: WarcRecordType;

    /** Byte offset of the record's WARC header block within the file. */
    offset: number;

    /** Content-Length from the WARC header: the whole record body, HTTP headers included. */
    length: number;

    /** WARC-IP-Address, the host the crawler actually connected to. */
    ip: string | null;

    /**
     * WARC-Concurrent-To — the request record captured alongside this response.
     * Bare uuid, brackets stripped, matching this record's own `uuid` format.
     */
    concurrentTo: string | null;

    /** WARC-Refers-To, set on revisit records: the earlier capture this one deduplicates against. */
    refersTo: string | null;

    /**
     * WARC-Payload-Digest, at the RECORD level rather than only inside `payload`.
     *
     * A revisit has no payload block at all, so the copy on WarcPayloadLocation is
     * unreachable for exactly the records that need it most: a revisit's whole
     * purpose is to say "my bytes are the ones with this digest", and resolving it
     * means looking the digest up. Hence a second home for the same value.
     */
    digest: string | null;

    /**
     * WARC-Refers-To-Target-URI and WARC-Refers-To-Date (both WARC 1.1).
     *
     * The fallback path when a digest lookup misses. Note the referred URL is
     * frequently a DIFFERENT url from this record's own — deduplication is by
     * bytes, not by address — so these are not a synonym for `url`.
     */
    refersToUri: string | null;
    refersToDate: string | null;

    /**
     * WARC-Truncated reason ("length", "time", "disconnect", …) when the crawler
     * stored a partial body. Non-null means payload.size is short of the real
     * response and any digest check against it will fail.
     */
    truncated: string | null;

    http: WarcHttpInfo | null;

    /** Null for records with no body of their own, e.g. a revisit that defers to refersTo. */
    payload?: WarcPayloadLocation | null;
}

export interface WarcRecordEntries {
    records:WarcRecord[];

    /**
     * url -> every record captured at that url, across every loaded file.
     *
     * Records with no url are NOT in here. They would all land under the same
     * '' key, which made them a "group" that shares a lastArchived — so a
     * warcinfo written in September displayed October's date because some other
     * file's warcinfo was newer. Absence is the correct answer: a record with no
     * target url is not a capture of anything, so it has no siblings.
     */
    /**
     * How many records are held, and how many of those are responses.
     *
     * Running totals, incremented in pushRecord, rather than derived on read.
     * `records.length` is free but the response count is not: it is a filter over
     * every record held, and the titlebar that shows it wakes once per animation
     * frame during a parse — 7,274 iterations sixty times a second to learn a
     * number that changed by one.
     *
     * `records` counts EVERYTHING, including the url-less warcinfo and the
     * `urn:pageinfo:` crawler metadata that never reaches the tree. `responses` is
     * the subset worth browsing, and the gap between them is wide: 7,274 against
     * 3,050 on the container on hand, because a WARC pairs a request with every
     * response and Browsertrix adds revisits on top.
     */
    recordCount: number;
    responseCount: number;

    recordsUrlMap:Map<string, WarcRecord[]>;

    /**
     * WARC-Payload-Digest -> every record that actually HOLDS those bytes.
     *
     * The revisit index. A revisit record stores no body; it says "my payload is
     * the one with this digest", which under the `identical-payload-digest` profile
     * is a guarantee rather than a hint. This map is what turns that into bytes.
     *
     * DONORS ONLY — a record is in here if it has a payload of its own. Revisits
     * are looked UP in it and never listed in it, so a chain of revisits pointing
     * at each other cannot form a cycle.
     *
     * Cross-file by construction, and it has to be: measured on the WACZ on hand,
     * only 19% of a single archive's revisits resolve within that archive, because
     * Browsertrix spreads records across four of them. Across the whole container
     * it is 329/329. A per-file index would answer "no payload" four times out of
     * five for records that are perfectly readable.
     */
    recordsDigestMap:Map<string, WarcRecord[]>;

    /**
     * customId of every record already stored.
     *
     * Pressing "Process locally" a second time re-parses the same files and
     * pushes every record again — the tree doubled, capture counts doubled, and
     * the timeline listed each snapshot twice. This is the guard.
     *
     * Keyed on customId (`file::url::uuid`), NOT on the bare WARC-Record-ID. A
     * record id is unique within one archive but repeats across derived ones —
     * a WARC built from another WARC carries the original ids — so deduping on
     * uuid alone would silently drop real records from a second file. See
     * WarcRecord.customId.
     */
    seenRecordIds: Set<string>;

    /**
     * Records held but deliberately absent from recordTree.
     *
     * A warcinfo record describes the FILE — crawler software, capture
     * settings, operator — and carries no WARC-Target-URI at all, so there is
     * no node in a url tree that could hold it. It is still real data worth
     * keeping, hence a second list rather than a drop. `records` holds these
     * too; this is the subset, not a separate store.
     */
    untreedRecords: WarcRecord[];

    /**
     * Roots of the URL tree, one per origin. Lives here rather than beside it in
     * the store so pushRecord — which only ever receives this object — can keep
     * the tree in step with every record it files.
     */
    recordTree: WarcRecordTreeNode[];

    /**
     * node url -> node, for every node in recordTree.
     *
     * Without it, inserting a record means scanning `children` at each level to
     * find the segment, which is O(siblings) per level — and a single crawled
     * host routinely has thousands of siblings under one directory. With it, an
     * insert is one Map lookup per path segment regardless of how wide the tree
     * gets. Kept beside the tree, not inside the nodes, so WarcRecordTreeNode
     * stays a plain serialisable shape.
     */
    recordTreeIndex: Map<string, WarcRecordTreeNode>;

    /**
     * The same records, rooted by host alone — no scheme, no `www.`.
     *
     * A second tree rather than a transformation of the first, because a reader
     * wants to switch between them: the raw tree is the archive's own account of
     * itself, where `http://www.example.com` and `https://example.com` are two
     * different roots because they are two different origins, and the normalized
     * one is the site as a person thinks of it.
     *
     * Built in the same pass by pushRecordIntoTree, so the two can never disagree
     * about what has been parsed.
     *
     * NOT the same set of records. The raw tree rejects any scheme the URL spec
     * calls non-special — which includes `onion:` and `i2p:`, both of which have
     * real hosts — so those appear here and nowhere else.
     */
    normalTree: WarcRecordTreeNode[];
    normalTreeIndex: Map<string, WarcRecordTreeNode>;

    /**
     * segment -> every node carrying that segment. One per tree.
     *
     * The search index. Finding "garden" by walking the tree means visiting every
     * node on every keystroke — 1,806 on 5am.warc and far more on onionfarms —
     * where walking the DISTINCT segments visits each name once and hands back
     * the nodes that have it.
     *
     * NODES, not records. The same segment sits under hundreds of different
     * parents, so `index.html` as a bag of records would be an undifferentiated
     * pile with nothing to say where any of it came from. A node knows its url,
     * its own records, and — through parentUrlOf — its whole ancestry, which is
     * what lets a search redraw the tree rather than just list hits.
     *
     * Filled by ensureTreeNode, the one place a node is created, so it cannot
     * drift from the tree and needs no rebuild when records arrive mid-parse.
     */
    segments: Map<string, WarcRecordTreeNode[]>;
    normalSegments: Map<string, WarcRecordTreeNode[]>;

    /**
     * content type -> every node holding a record of it. One per tree.
     *
     * The other half of the search index, and the source of the type dropdown —
     * which is built from what the archive ACTUALLY contains rather than from a
     * hardcoded list, so a WARC full of `application/x-shockwave-flash` says so.
     *
     * Already normalized on arrival: `record.contentType` is the bare, lowercased
     * base type, split off the full header by wire.ts at parse time, so
     * "text/html; charset=utf-8" and "TEXT/HTML" are one key and no work happens
     * on this path.
     *
     * A SET of nodes, not an array. One node commonly holds several captures of
     * one page, and an array would list it once per matching record.
     */
    contentTypes: Map<string, Set<WarcRecordTreeNode>>;
    normalContentTypes: Map<string, Set<WarcRecordTreeNode>>;

    /**
     * node url -> how many times that node's own contents changed.
     *
     * Shared by BOTH trees, and safe to share: a raw node's url always carries a
     * scheme and a normalized one never does, so the two key spaces cannot
     * overlap. One map means the existing per-node notification machinery serves
     * both without a second channel.
     *
     * Nodes are mutated in place, so their identity never changes and a row has
     * no way to notice a record landing on it. This counter is that signal: a row
     * subscribes to its own url and re-renders only when its own number moves.
     *
     * The alternative — rebuilding the node and its ancestors so identity
     * changes — is what makes React.memo work on a tree, but every rebuild copies
     * each ancestor's `children` array, which is O(siblings) per level. A
     * directory with ten thousand children would copy ten thousand entries per
     * record. Counting is O(1) and leaves the tree mutable.
     */
    treeVersions: Map<string, number>;

    /**
     * Nodes whose version has moved since the last flush.
     *
     * The set of rows worth waking. Written by bumpTreeVersion, drained by the
     * store's flush — without it the store would have to notify every row and let
     * each work out for itself that nothing had changed, which is exactly the
     * O(mounted rows) per frame this replaces.
     */
    dirtyTreeUrls: Set<string>;
}

/**
 * Per-node change notifications for the record tree.
 *
 * Shaped like WarcTreeExpansion in recordListingTree, and for the same reason:
 * a row that reads a NUMBER out of a store re-renders when its own number moves,
 * whereas a row reading the tree out of context re-renders whenever anything
 * anywhere changes. During a parse that difference is one row per frame against
 * every mounted row per frame.
 */
export interface WarcTreeVersions {
    /**
     * A subscribe function for ONE node's version.
     *
     * Keyed rather than global: a single shared listener set meant every mounted
     * row was woken on every flush just to discover its own number had not moved.
     * Must return the same function for the same url — useSyncExternalStore
     * resubscribes whenever the identity changes.
     */
    subscribeTo: (url: string) => (listener: () => void) => () => void;

    versionOf: (url: string) => number;
}

/**
 * The parts of the offline state that NEVER change identity.
 *
 * Everything here is either a store, an index mutated in place, or an action
 * bound once — so this object is built once per provider and handed out
 * unchanged forever. A component reading it is never re-rendered by the store.
 *
 * That is the whole point of the split. There used to be one snapshot carrying
 * all of this plus the view and file state, rebuilt on every flush, and a flush
 * happens once per animation frame while a parse is running. Every consumer of
 * the context re-rendered sixty times a second regardless of what it read.
 *
 * Change signals live on their own channels instead:
 *   - the record tree     -> treeVersions, keyed per node url
 *   - the current view    -> WarcViewState
 *   - the file selection  -> WarcFilesState
 */
export interface WarcRecordContextType {
    recordTree: WarcRecordTreeNode[];

    /** The same records rooted by host alone. See WarcRecordEntries.normalTree. */
    normalTree: WarcRecordTreeNode[];

    /**
     * Per-node change signal for the tree rows. A row subscribes to its own url
     * and wakes only when that node's own contents moved.
     */
    treeVersions: WarcTreeVersions;
    recordEntries: WarcRecordEntries;

    /** Non-fatal problems, accumulated across views. Drives the corner badge. */
    notices: WarcNoticeStore;

    /**
     * Downloads in flight, and how the last few ended. Drives the corner cards.
     *
     * On the STABLE half, like `notices`: its identity never changes, and anything
     * watching it subscribes to the store rather than to a snapshot passed down
     * here. A download outlives the view that started it, so it cannot live on
     * the view slice — closing a page must not touch a zip being written.
     */
    downloads: WarcDownloadStore;

    pushRecord: ((record: WarcRecord, recordsRef: WarcRecordEntries) => void) | undefined;
    pushFileHandle: ((handle: WarcFileHande, handlesRef: WarcFileHande[]) => void) | undefined;

    setFileHandles: ((handles: WarcFileHande[], handlesRef: WarcFileHande[]) => void) | undefined;

    // Not a promise any more: the parser url is a same-origin path, so the pool
    // is built synchronously and the handles exist by the time this returns.
    parseFileHandles: ((workers: number, handles: WarcFileHande[], recordsRef: WarcRecordEntries) => WarcWorkerHandle[]) | undefined;

    /**
     * Rebuild an archived record as a blob url an iframe can show.
     *
     * Returns an outcome rather than throwing, because "this page cannot be
     * shown" and "this page is missing three images" are different answers and
     * the caller has to handle both. See view.ts.
     */
    viewArchivedRecord: ((record: WarcRecord, recordsRef: WarcRecordEntries) => Promise<ViewOutcome>) | undefined;

    /**
     * Show a rebuilt document. Revokes whatever was showing before it, and files
     * everything the page could not find into `notices`.
     *
     * Takes the whole outcome so that reporting cannot be skipped by a caller
     * that only wanted to display the page — see the note in store.ts.
     */
    showBlob: ((outcome: Extract<ViewOutcome, { ok: true }>) => void) | undefined;

    /** Show why a document could not be rebuilt. */
    showViewFailure: ((failure: Extract<ViewOutcome, { ok: false }>) => void) | undefined;

    /** Close the current view, revoke its blob urls, and drop the history trail. */
    clearView: (() => void) | undefined;

    /**
     * Step through the trail. Rebuilds the page there — history holds records,
     * not built documents, so that twenty pages back is not twenty pages of
     * images still held in memory.
     *
     * These move the BROWSER's history cursor, and the store follows the popstate
     * it produces. So the arrow in the frame and the tab's own Back button are one
     * action rather than two cursors drifting apart.
     */
    goBack: (() => void) | undefined;
    goForward: (() => void) | undefined;

    /** Jump to an absolute position in the trail, for the history dropdown. */
    goToView: ((index: number) => void) | undefined;

    /**
     * File non-fatal problems observed outside a view's own build — the fetch and
     * XHR shim's misses, which arrive from inside the iframe after the fact.
     */
    reportMissing: ((viewing: string, refs: readonly MissingRef[]) => void) | undefined;
}

/**
 * What the frame is showing. A new object only when the view actually changes.
 *
 * Small on purpose: this is the slice that has to be rebuilt on navigation, and
 * everything in it is read by the viewer and by the capture timeline, which are
 * the only two components that care what is on screen.
 */
export interface WarcViewState {
    /** Blob url of the capture currently in the iframe, or null. */
    recordBlobUrl: string | null;

    /** MIME type of recordBlobUrl, so the iframe can be told what it is holding. */
    recordBlobType: string | null;

    /**
     * The fatal outcome of the last view attempt, or null.
     *
     * Shown IN PLACE OF the document, not in the corner badge — a fatal error
     * means nothing rendered, so a reader who never opens the badge would be
     * staring at a blank frame with no explanation.
     */
    viewFailure: Extract<ViewOutcome, { ok: false }> | null;

    /**
     * The capture currently on screen, or null when nothing is.
     *
     * The record rather than its url, because the capture timeline needs to mark
     * WHICH capture of that url is showing, and several may share one address.
     */
    viewingRecord: WarcRecord | null;

    /**
     * Where the document on screen redirects to, when it is a redirect that was
     * shown rather than followed — a 3xx with a body. Null otherwise.
     *
     * On the view, not kept by whichever component navigated: a link, the
     * timeline, the tree and the history arrows all navigate, and the
     * "Redirecting to" bar has to appear for every one of them.
     */
    viewingRedirectsTo: string | null;

    /** Whether there is anywhere to go. Both false before anything is opened. */
    canGoBack: boolean;
    canGoForward: boolean;

    /**
     * Every page this browsing session has been through, oldest first.
     *
     * The store's own trail, handed out for reading. Records, not urls: two
     * entries can share an address and be different captures, and the dropdown
     * shows when each one was taken to tell them apart.
     *
     * A frozen view of the store's array, not the array itself — a consumer that
     * sorted or reversed it in place would silently rewrite the reader's history.
     */
    viewTrail: readonly WarcRecord[];

    /**
     * Where in `viewTrail` the frame is, or -1 when nothing is showing.
     *
     * Needed as well as canGoBack/canGoForward because the dropdown marks the
     * current entry and jumps to an absolute position, neither of which can be
     * worked out from two booleans.
     */
    viewIndex: number;
}

/**
 * The selected files. A new object only when the SELECTION changes.
 *
 * Deliberately not rebuilt by parse progress: progress moves fields on the
 * handles, and the listing rows watch their own file through progress.ts rather
 * than being re-rendered from above.
 */
export interface WarcFilesState {
    /**
     * MUTATED IN PLACE — the same array on every snapshot. Its identity is not a
     * signal; `revision` is.
     */
    fileHandles: WarcFileHande[];

    /** Changes when a file is added or the set replaced, and only then. */
    revision: number;
}
