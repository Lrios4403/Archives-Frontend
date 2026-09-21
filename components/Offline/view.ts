'use client';

/**
 * Viewing an archived page from local files.
 *
 * Owns a dedicated view Worker and answers its resolve requests out of
 * recordsUrlMap. The worker never receives the index — see backend/parser/view.ts
 * for why — so this module is the only thing that knows how to turn a url and a
 * date into a record.
 *
 * A SEPARATE worker instance from the four parse workers, though it is built from
 * the same bundle. A view request sent to a parse worker would queue behind a
 * 1.6 GB parse and arrive minutes later.
 */

import { parserScriptUrl, warmParserScript } from "./parserBundle";
import { WarcGzipLocation, WarcRecord, WarcRecordEntries } from "./types";
import { payloadSize } from "./format";
import { getPrefs } from "./prefs";

/** Mirrors ViewFatalReason in backend/parser/view.ts. */
export type ViewFatalReason = 'not-archived' | 'no-payload' | 'unreadable' | 'redirect' | 'decode';

/** Mirrors MissingReason in backend/parser/view.ts. */
export type MissingReason =
    | 'not-archived' | 'no-payload' | 'unreadable' | 'depth-limit' | 'cycle' | 'dynamic'
    /** A 3xx chain that loops, or runs past MAX_REDIRECTS. */
    | 'redirect'
    /** The capture records an HTTP error — a 404 page stored under an asset url. */
    | 'error-status';

export interface MissingRef {
    url: string;
    reason: MissingReason;
    referrer: string;
}

/**
 * A discriminated union rather than a throw, so a caller cannot skip the failure
 * branch — and `revoke` exists only where it means something.
 */
/** A reference that resolved, and to what. Mirrors ResolvedRef in the worker. */
export interface ResolvedRef {
    url: string;
    /** The record that answered. Differs from `url` when a lookup fell back. */
    servedUrl: string;
    type: string;
    bytes: number;
    referrer: string;
    /**
     * The 3xx hops walked to get here, in order, excluding the url first asked
     * for. Empty for the ordinary case.
     *
     * Present so a `servedUrl` that differs from `url` can be told apart from a
     * lookup that fell back to the wrong thing — see the warning in the `viewed`
     * handler, which a followed redirect would otherwise trip on every hop.
     */
    redirects?: string[];
}

export type ViewOutcome =
    | {
        ok: true;
        /**
         * The record that rendered.
         *
         * Attached on the main thread rather than sent back by the worker — the
         * worker was posted a stripped ViewRecord and never had the full one. It
         * is here because both history and the capture timeline need to know what
         * is currently showing, and re-deriving it from `documentUrl` means
         * repeating a lookup whose answer was already decided.
         *
         * After a redirect this is the DESTINATION's record, not the one asked
         * for, which is what makes Back land where the reader actually was.
         */
        record: WarcRecord;
        /** Blob url of the document. Feed this to an iframe. */
        url: string;
        /**
         * The ARCHIVED address of what rendered — what to call this page when
         * reporting on it. `url` is a blob uuid, and after a redirect this is not
         * the url that was asked for either.
         */
        documentUrl: string;
        /**
         * Set when the document on screen is itself a redirect that was NOT
         * followed — a 3xx with a body, shown on purpose — and names where it
         * leads. The viewer offers to follow it. Null for an ordinary page,
         * and for a redirect that WAS followed (the record is then the
         * destination). See prefs.followRedirectsWithBody.
         */
        redirectsTo: string | null;
        type: string;
        /** References the archive did not contain. Never fatal; the page rendered. */
        missing: MissingRef[];
        /**
         * References that DID resolve. Present for diagnosis, not for display: a
         * url answered by the wrong record is invisible in `missing`, and this is
         * the only place it can be seen.
         */
        resolved: ResolvedRef[];
        /**
         * MUST be called when the view closes or navigates. Every blob url pins
         * its Blob in memory, so a page of a hundred images opened twenty times
         * and never revoked holds all two thousand.
         */
        revoke: () => void;
    }
    | { ok: false; reason: ViewFatalReason; url: string; errorName: string; message: string };

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Mirrors ViewStage in backend/parser/view.ts. */
export type ViewStage = 'reading' | 'resolving' | 'rewriting' | 'done';

/** Mirrors ViewProgress, plus the id so a stale view can be told apart. */
export interface ViewProgress {
    stage: ViewStage;
    url: string;
    resolved: number;
    total: number;
}

const progressListeners = new Set<() => void>();

/** The latest report, or null when nothing is being built. */
let currentProgress: ViewProgress | null = null;

/**
 * The view whose progress is worth showing.
 *
 * Only the newest matters. A superseded rebuild — three quick Backs, or a link
 * clicked while another is still loading — keeps running to completion so it can
 * revoke its own blobs, and its progress must not drive an overlay describing a
 * page nobody is waiting for any more.
 */
let latestViewId = 0;

/**
 * How far the current rebuild has got.
 *
 * A store in its own right rather than a field on the record store, for two
 * reasons. Views start from four places — a link click, the tree's View button,
 * the capture timeline, and Back/Forward — so a module-level sink means none of
 * them has to remember to pass a callback. And subscribing from inside
 * createWarcRecordStore would leak a listener every time React double-invokes
 * the initialiser in development, against a store it then throws away.
 *
 * Shaped like the notice store, and read the same way: the overlay subscribes
 * directly with useSyncExternalStore.
 */
export const viewProgressStore = {
    subscribe: (listener: () => void): (() => void) => {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
    },

    /**
     * Identity is stable between changes, which is what useSyncExternalStore
     * compares — a fresh object per call would re-render forever.
     */
    getSnapshot: (): ViewProgress | null => currentProgress,

    /** Nothing has been built on the server, so both sides agree on null. */
    getServerSnapshot: (): ViewProgress | null => null,
};

const reportProgress = (progress: ViewProgress | null) => {
    currentProgress = progress;
    progressListeners.forEach(listener => listener());
};

/** The cloneable subset of a record the worker needs. No functions, no handle. */
interface PostedViewRecord {
    url: string;
    contentType: string;
    dateArchived: string;
    // Blob, not File: a record's bytes may come from an archive sliced out of a
    // container. See WarcFileHande.file.
    file: Blob;
    payload: {
        offset: number;
        size: number;
        chunks?: number[];
        digest?: string | null;
        /**
         * Where the bytes physically are, for a `.warc.gz` or `.wacz`.
         *
         * MUST be copied through in toPostedRecord. This block is rebuilt field by
         * field rather than spread, so a field omitted here does not fail to
         * compile — it silently does not reach the worker, which then slices a
         * compressed file at a logical offset and renders the result. That is not
         * hypothetical: it is what this field was missing when .warc.gz support
         * first landed.
         */
        gzip?: WarcGzipLocation;
    } | null;
    /** For naming files inside a download. See ViewRecord in the backend. */
    uuid?: string;
    warcFile?: string;
    httpContentType?: string | null;
    /**
     * `Content-Encoding` from the captured response — "gzip", "br", or null.
     *
     * A separate axis from the archive's own compression: a gzipped body can sit
     * inside an already-gzipped member, and the two decode in order (member,
     * then chunked framing, then this).
     */
    contentEncoding?: string | null;
    /** So the worker can refuse to descend into a 404 page stored under an asset url. */
    status?: number | null;
}

/**
 * Exported so download.ts can post the same shape without duplicating it.
 *
 * The digest goes across too, which the viewer never needed: a download merges
 * byte-identical captures — the `http://` and `https://` of one page — into a
 * single zip entry, and the digest is what makes them recognisable as identical.
 */
export const toPostedRecord = (record: WarcRecord): PostedViewRecord => ({
    url: record.url,
    contentType: record.contentType,
    dateArchived: record.dateArchived.toISOString(),
    uuid: record.uuid,
    warcFile: record.fileHandle.name,
    file: record.fileHandle.file,
    payload: record.payload
        ? {
            offset: record.payload.offset,
            size: record.payload.size,
            chunks: record.payload.chunks,
            digest: record.payload.digest,
            // Without this the viewer reads compressed bytes from a logical
            // offset for every record in a .warc.gz — see PostedViewRecord.
            gzip: record.payload.gzip,
        }
        : null,
    httpContentType: record.http?.contentType ?? null,
    contentEncoding: record.http?.contentEncoding ?? null,
    status: record.http?.status ?? null,
});

// ---------------------------------------------------------------------------
// Finding the right record
// ---------------------------------------------------------------------------

/** Canonical query form, matching what the tree builder uses. */
const canonicalQuery = (url: URL): string => {
    const params = new URLSearchParams(url.search);
    params.sort();
    return params.toString();
};

/**
 * Whether two urls name the same target once fragment and query ORDER are set
 * aside — that is, whether one is a key `lookupKeys` would have produced for the
 * other.
 *
 * Used only to keep the diagnostic below honest. `Girlfriend-Regular.eot?#iefix`
 * being answered by `Girlfriend-Regular.eot` is a deliberate fallback, not a
 * wrong answer, and the bulletproof-@font-face hack puts that spelling on nearly
 * every page with a webfont — so without this the warning fires constantly and
 * stops being worth reading.
 */
const sameTarget = (a: string, b: string): boolean => {
    if (a === b) return true;

    try {
        const x = new URL(a);
        const y = new URL(b);
        return x.origin === y.origin && x.pathname === y.pathname && canonicalQuery(x) === canonicalQuery(y);
    } catch {
        return false;
    }
};

/**
 * Lookup keys to try, in order.
 *
 * recordsUrlMap is keyed by the RAW url a record carried, and a reference in a
 * page can differ from it cosmetically without meaning anything different: a
 * fragment the server never saw, or query parameters in another order. Trying
 * the exact form first means an exact match always wins.
 */
const lookupKeys = (rawUrl: string): string[] => {
    const keys = [rawUrl];

    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return keys;
    }

    const withoutFragment = `${url.origin}${url.pathname}${url.search}`;
    if (withoutFragment !== rawUrl) keys.push(withoutFragment);

    const query = canonicalQuery(url);
    const canonical = `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
    if (!keys.includes(canonical)) keys.push(canonical);

    return keys;
};

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

/**
 * Statuses that name somewhere else to fetch instead.
 *
 * 300 and 305 are deliberately absent. A 300 Multiple Choices has no single
 * destination to follow — its Location is a suggestion among several — and 305
 * Use Proxy names a proxy, not a document. 304 is not here either: it means
 * "your cache is fine", which in an archive is a record with no body, and that
 * is already `no-payload`.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Where a record redirects to, absolute, or null if it is not a redirect.
 *
 * `Location` is legally relative — `garden`, `/navi/rose/garden`, `../index.html`
 * — so it is resolved against the record's OWN url rather than the url that was
 * asked for. Those differ once a chain is more than one hop long, and resolving
 * against the wrong one silently lands on a sibling directory.
 */
const redirectTarget = (record: WarcRecord): string | null => {
    const status = record.http?.status;
    if (status === null || status === undefined || !REDIRECT_STATUSES.has(status)) return null;

    const location = record.http?.location?.trim();
    if (!location) return null;

    try {
        return new URL(location, record.url).href;
    } catch {
        // A Location that will not parse even against a base is not followable.
        // Treated as "not a redirect" so the record's own body, if it has one,
        // still gets a chance to render.
        return null;
    }
};

/**
 * The rule is literal: a redirect with ANY body is shown before it is followed.
 *
 * This is the archive owner's call, made knowing the numbers. Measured across
 * this archive's 1,143,853 redirects on 2026-09-08: 736,535 have a body, and
 * 92.2% of those are under 256 bytes — nginx/openresty's "301 Moved
 * Permanently … <center>openresty</center>" at 166-185 B, Apache's "The
 * document has moved <a>here</a>" at ~261 B. 5amgirlfriend's garden.html ->
 * garden, the case that prompted the wait, is a 166-byte openresty stub, and
 * it is exactly the page the owner wants to see before moving on: it IS what
 * the server sent, and the archive's job is to show what was captured.
 *
 * A threshold of 512 was tried and rejected — it hid precisely that page. The
 * escape for anyone who finds the stubs tiresome is "Don't show again" on the
 * bar (prefs.followRedirectsWithBody), which is per reader, not per archive.
 * Raise this only if the owner asks; the data above says what raising it hides.
 */
const REDIRECT_BODY_MIN_BYTES = 1;

/**
 * Whether a redirect record carries anything at all in its body. Decides
 * whether a top-level navigation waits (see prefs.followRedirectsWithBody) or
 * follows. A header-only 3xx — the 301 that is nothing but a Location — is the
 * one kind that is always followed without asking; there is nothing to show.
 */
const redirectHasBody = (record: WarcRecord): boolean =>
    (payloadSize(record.payload) ?? 0) >= REDIRECT_BODY_MIN_BYTES;

export interface NearestOptions {
    /**
     * Stop the walk at the first redirect that has a body, and hand THAT back
     * with `redirectsTo` set, instead of following it.
     *
     * Off by default, and every subresource lookup leaves it off: a stylesheet
     * behind a 301 with a stub body must still resolve to the stylesheet. Only a
     * top-level navigation — something the reader will look at — turns it on.
     */
    stopAtBodiedRedirect?: boolean;
}

/**
 * How many hops to walk before giving up.
 *
 * Real chains are one or two — http->https, or a trailing-slash canonicalisation.
 * Anything past five is a loop the visited set somehow did not catch, or a crawl
 * that captured a redirect ladder nobody wants to sit through.
 */
const MAX_REDIRECTS = 5;

export interface NearestRecordResult {
    record: WarcRecord | null;
    reason?: MissingReason;
    /** Hops walked, in order, EXCLUDING the url first asked for. Usually empty. */
    redirects: string[];
    /** The last url looked up: the end of the chain, or the url asked for. */
    finalUrl: string;
    /**
     * Set when the walk stopped EARLY at a redirect that carries a body, because
     * the caller asked it to (stopAtBodiedRedirect). `record` is then that
     * redirect, and this is where it points. Never set for subresources.
     */
    redirectsTo?: string | null;
}

/**
 * The capture of `url` nearest `nearArchived`, without following redirects.
 *
 * Nearest rather than newest, because a page archived in 2019 should be dressed
 * in the stylesheet that was captured alongside it, not one from a crawl three
 * years later. This is the same rule the backend's get_warc_response_payload_near
 * applies, kept deliberately in step with it.
 */
/**
 * A revisit record, rewritten to point at the bytes it defers to.
 *
 * A revisit says "this url was re-crawled and the body is unchanged", storing the
 * headers and no body. Under `WARC-Profile: …/identical-payload-digest` — which is
 * what Browsertrix writes, on all 329 in the archive on hand — the payload digest
 * is a guarantee, so the donor is any record carrying that digest.
 *
 * The returned record keeps the REVISIT'S identity — its url, its date, its place
 * in the tree — and borrows only what it takes to read bytes: the payload location
 * and the file that holds them. Returning the donor itself instead would be simpler
 * and wrong; the donor is frequently a different url (deduplication is by bytes,
 * not by address), so the viewer would show the reader a page they did not click on
 * and a timestamp from the wrong capture.
 *
 * Null when nothing holds the bytes, which is the honest answer when only part of a
 * container has been loaded.
 */
const resolveRevisit = (
    revisit: WarcRecord,
    entries: WarcRecordEntries,
): WarcRecord | null => {
    const donor = revisitDonor(revisit, entries);

    if (!donor?.payload) return null;

    return {
        ...revisit,
        // The donor's file, not the revisit's: the bytes live in whichever archive
        // the donor came from, which in a .wacz is routinely a different one.
        fileHandle: donor.fileHandle,
        payload: donor.payload,
        // mwarc does not parse the HTTP block of a revisit — only `response` takes
        // that path — so a revisit arrives with no http info and no content type,
        // and an iframe handed a blob with no type renders it as a download. The
        // donor's are correct by definition here: identical bytes, and it is the
        // same resource.
        http: revisit.http ?? donor.http,
        contentType: revisit.contentType || donor.contentType,
    };
};

/** The record holding a revisit's bytes: by digest, then by refers-to. */
const revisitDonor = (
    revisit: WarcRecord,
    entries: WarcRecordEntries,
): WarcRecord | undefined => {
    // Digest first. It is the profile's own guarantee, it needs no date matching,
    // and it resolved 329/329 across the container — where matching on the referred
    // url alone would also have worked here but is the weaker claim.
    if (revisit.digest) {
        const sharing = entries.recordsDigestMap.get(revisit.digest);

        // Nearest by date among donors, so a url captured many times lends the
        // copy closest to this revisit rather than an arbitrary one.
        if (sharing && sharing.length > 0) return nearestByDate(sharing, revisit.dateArchived);
    }

    // Fallback for archives whose revisits carry no digest, or a digest computed
    // with an algorithm nothing else in the file used.
    if (!revisit.refersToUri) return undefined;

    const referred = entries.recordsUrlMap.get(revisit.refersToUri);
    if (!referred) return undefined;

    const donors = referred.filter(record => record.payload);
    if (donors.length === 0) return undefined;

    const at = revisit.refersToDate ? new Date(revisit.refersToDate) : revisit.dateArchived;

    return nearestByDate(donors, Number.isNaN(at.getTime()) ? revisit.dateArchived : at);
};

/** The member of `records` archived closest to `at`. */
const nearestByDate = (records: WarcRecord[], at: Date): WarcRecord => {
    const target = at.getTime();

    let best = records[0]!;
    let bestDistance = Math.abs(best.dateArchived.getTime() - target);

    for (const record of records) {
        const distance = Math.abs(record.dateArchived.getTime() - target);

        // Strictly closer, so a tie keeps the earlier one and the answer does not
        // depend on insertion order.
        if (distance < bestDistance) {
            best = record;
            bestDistance = distance;
        }
    }

    return best;
};

const nearestCapture = (
    entries: WarcRecordEntries,
    rawUrl: string,
    nearArchived: string,
): { record: WarcRecord | null; reason?: MissingReason } => {
    let group: WarcRecord[] | undefined;

    for (const key of lookupKeys(rawUrl)) {
        group = entries.recordsUrlMap.get(key);
        if (group) break;
    }

    if (!group || group.length === 0) return { record: null, reason: 'not-archived' };

    // Responses only: a request record shares the url but has no body.
    //
    // A redirect counts as usable even with no body at all, which is the whole
    // point — a 301 is almost always stored as headers and nothing else, and
    // requiring a payload here is what made a redirected link report "captured
    // with no body" instead of following it. A redirect that DOES carry a body
    // (the "Moved Permanently" stub some servers send) is still preferred as a
    // redirect: the reader wants the destination, not the stub.
    //
    // Revisits join them, resolved to whichever record holds the bytes. Without
    // this a url captured only as a revisit reported "captured with no body"
    // despite the bytes sitting in the same container — 329 records in the WACZ on
    // hand, 4.5% of it, and every one of them readable.
    const usable = group.flatMap(record => {
        if (record.type === 'revisit') {
            const resolved = resolveRevisit(record, entries);
            return resolved ? [resolved] : [];
        }

        if (record.type !== 'response') return [];

        return record.payload || redirectTarget(record) !== null ? [record] : [];
    });

    if (usable.length === 0) return { record: null, reason: 'no-payload' };

    const target = new Date(nearArchived).getTime();
    const targetIsValid = Number.isFinite(target);

    let best = usable[0]!;
    let bestDistance = targetIsValid ? Math.abs(best.dateArchived.getTime() - target) : 0;

    for (const record of usable) {
        if (!targetIsValid) {
            // No usable target date: fall back to the newest capture.
            if (record.dateArchived > best.dateArchived) best = record;
            continue;
        }

        const distance = Math.abs(record.dateArchived.getTime() - target);

        // Strictly closer, so an exact tie keeps the earlier one and the choice
        // does not depend on iteration order.
        if (distance < bestDistance) {
            best = record;
            bestDistance = distance;
        }
    }

    return { record: best };
};

/**
 * The capture of `url` nearest `nearArchived`, following redirects.
 *
 * The single choke point every lookup goes through — a clicked link, a form
 * submission, and every subresource the worker asks for — so following the chain
 * here fixes all three at once rather than at each call site.
 *
 * Why this has to exist at all: a crawler that followed `garden.html -> garden`
 * stored BOTH, the first as a 301 with headers and no body. Without this, the
 * lookup found that 301, saw no payload, and reported "captured with no body" —
 * a dead link on a page whose destination is sitting right there in the archive.
 *
 * `nearArchived` is held FIXED across hops rather than advanced to each record's
 * own date. The reader asked for one moment in time, and re-targeting per hop
 * lets a chain drift: a 2019 redirect captured once, whose destination was
 * crawled in 2019 and 2023, should land on the 2019 destination.
 *
 * The returned record is the DESTINATION, so its `url` becomes the base the
 * rewriter resolves relative references against — which is what makes
 * `./style.css` on the redirected page resolve to the destination's directory
 * rather than the redirect's.
 */
export const findNearestRecord = (
    entries: WarcRecordEntries,
    rawUrl: string,
    nearArchived: string,
    options?: NearestOptions,
): NearestRecordResult => {
    const redirects: string[] = [];

    // Cycle detection on the RECORD, not the url. Lookups are deterministic for
    // a fixed nearArchived, so meeting a record twice is exactly a loop — and it
    // catches loops that url comparison misses, where two spellings of an
    // address resolve to the same capture.
    const seen = new Set<string>();

    let url = rawUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const found = nearestCapture(entries, url, nearArchived);

        if (!found.record) return { ...found, redirects, finalUrl: url };

        if (seen.has(found.record.customId)) {
            return { record: null, reason: 'redirect', redirects, finalUrl: url };
        }

        seen.add(found.record.customId);

        const next = redirectTarget(found.record);

        // Not a redirect: this is the answer.
        if (next === null) return { record: found.record, redirects, finalUrl: url };

        // A redirect with a page in it, and a caller who wants to see such
        // pages: this is the answer for now, and `redirectsTo` says where it
        // would have gone. The hops walked to reach it are still reported.
        if (options?.stopAtBodiedRedirect && redirectHasBody(found.record)) {
            return { record: found.record, redirects, finalUrl: url, redirectsTo: next };
        }

        redirects.push(next);
        url = next;
    }

    // Ran out of hops. Reported as a redirect failure rather than handing back
    // the last redirect record, which would render as a blank page or a "Moved
    // Permanently" stub and look like a different bug entirely.
    return { record: null, reason: 'redirect', redirects, finalUrl: url };
};

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

interface PendingView {
    settle: (outcome: ViewOutcome) => void;
    entries: WarcRecordEntries;
    /** What was actually sent to be built, so the outcome can name it. */
    record: WarcRecord;
    /** Where `record` redirects, when it is a bodied redirect being shown as-is. */
    redirectsTo: string | null;
}

let viewWorker: Worker | null = null;
const pendingViews = new Map<number, PendingView>();
let nextViewId = 1;

/**
 * The view worker, started on first use and kept for the session.
 *
 * One instance, not a pool: viewing is interactive and one page at a time, and a
 * second instance would mean a second copy of the bundle for no parallelism.
 */
/**
 * Ceiling on how long the prewarm will wait for an idle moment.
 *
 * The point of the prewarm is that the bundle is ready before a human can read
 * the page and click something, so a couple of seconds of slack costs nothing —
 * and the guarantee matters more than the speed: a page that never goes idle
 * would otherwise never prewarm at all.
 */
const PREWARM_IDLE_TIMEOUT = 2_000;

/** Where requestIdleCallback is missing, a plain delay past first render. */
const PREWARM_FALLBACK_DELAY = 1_000;

/**
 * Start the view worker soon, so the first View click does not pay for it.
 *
 * Fetching the parser bundle and spinning up a Worker is the fixed cost of the
 * first view — before that, every page load paid it at the exact moment a reader
 * was waiting. Idempotent: it is the same singleton getViewWorker returns, so a
 * prewarm followed by a real view is one worker.
 *
 * ## Why at idle, and not on mount
 *
 * It used to fire straight out of the mount effect, which put a cross-origin
 * request for a 190 KB bundle, a Blob, and a Worker construction in the same
 * moment as hydration — speculative work, at the highest priority the page ever
 * has, competing with the work the reader is actually waiting to see. The visible
 * result was the page hanging until index.js came back, which on a cold backend
 * is a Bun.build away.
 *
 * requestIdleCallback with a timeout is the right shape for exactly this: run
 * when nothing better is happening, but do not wait forever.
 *
 * Failures are swallowed ON PURPOSE. This is speculative work nobody asked for;
 * if the backend is down, the view that actually needs it will report that
 * properly, with a message and a fatal panel. A console error here would be
 * noise at page load pointing at a problem nothing has hit yet.
 *
 * Returns a cancel, so a viewer unmounted before the callback runs — a reader who
 * navigated straight past the page — does not fetch a bundle for a page that is
 * no longer there.
 */
export const prewarmViewWorker = (): (() => void) => {
    if (typeof window === 'undefined') return () => {};

    const start = () => {
        /*
         * Two jobs, in this order.
         *
         * warmParserScript puts the bundle in the HTTP cache and, unlike the
         * Worker constructor, actually looks at the response — so a 404 or an
         * HTML error page becomes a sentence a reader can act on rather than a
         * SyntaxError from inside a worker. It is also the only thing that reads
         * X-Parser-Built-At, which is what makes a stale-bundle report possible.
         *
         * Then the worker itself, which no longer waits for any of that: the url
         * is a path, so this is a constructor call and nothing more.
         */
        void warmParserScript();

        try {
            getViewWorker();
        } catch {
            // Speculative. The view that actually needs it reports properly.
        }
    };

    // Absent in Safari for most of its life, so this is a real branch rather than
    // defensive noise.
    if (typeof window.requestIdleCallback === 'function') {
        const handle = window.requestIdleCallback(start, { timeout: PREWARM_IDLE_TIMEOUT });

        return () => window.cancelIdleCallback?.(handle);
    }

    const timer = window.setTimeout(start, PREWARM_FALLBACK_DELAY);

    return () => window.clearTimeout(timer);
};

const getViewWorker = (): Worker => {
    if (viewWorker) return viewWorker;

    /*
     * Constructed here and now — no promise in front of it.
     *
     * This was `getParserUrl().then(parserUrl => …)`, wrapping every handler
     * below in a callback that could not run until a cross-origin fetch of the
     * parser bundle had resolved into a Blob. The url is a same-origin path now
     * (see parserBundle.ts), so the worker exists by the time this returns and
     * the two callers stopped needing to await it.
     */
    const worker = new Worker(parserScriptUrl());


    worker.onmessage = (event) => {
        const data = event.data;

        // The worker asking for a record. Answered from the caller's own
        // entries, so a view always resolves against the same store it was
        // started from even if another parse has begun since.
        if (data?.action === 'resolve') {
            // Answered from the entries the VIEW was started with, matched by
            // the viewId the worker echoes back. A view that outlives a store
            // swap still resolves against its own records.
            const pending = pendingViews.get(data.viewId);
            const found: Pick<NearestRecordResult, 'record' | 'reason'> & { redirects?: string[] } =
                pending
                    ? findNearestRecord(pending.entries, data.url, data.nearArchived)
                    : { record: null, reason: 'not-archived' as MissingReason };

            worker.postMessage({
                action: 'resolved',
                requestId: data.requestId,
                record: found.record ? toPostedRecord(found.record) : null,
                reason: found.reason,
                // So the worker can tell a followed redirect apart from a
                // lookup that fell back to the wrong record. Both show up as
                // servedUrl !== url, and only one of them is a bug.
                redirects: found.redirects,
            });
            return;
        }

        if (data?.action === 'viewed') {
            const pending = pendingViews.get(data.id);
            if (!pending) return;
            pendingViews.delete(data.id);

            // buildView reports `done` before returning, so this is belt and
            // braces — but a settled view with a progress report still up is
            // an overlay stuck over a finished page, and that is worth two
            // lines of insurance.
            if (data.id === latestViewId) reportProgress(null);

            const blobUrls: string[] = data.blobUrls ?? [];

            const resolved: ResolvedRef[] = data.resolved ?? [];

            // Logged, not just returned. The one bug this exists to catch —
            // a <script src> served a text/css record — shows up as a type
            // that does not belong, and there is nowhere else to notice it.
            //
            // Two kinds of difference are excluded because both are correct:
            // a followed redirect, and a fragment- or query-order fallback
            // that lookupKeys generated on purpose. What is left is a lookup
            // that answered with a genuinely different address.
            const surprising = resolved.filter(ref =>
                ref.url !== ref.servedUrl
                && (ref.redirects?.length ?? 0) === 0
                && !sameTarget(ref.url, ref.servedUrl));
            if (surprising.length > 0) {
                console.warn(
                    `viewArchivedRecord: ${surprising.length} reference(s) were answered by a ` +
                    `DIFFERENT url than was asked for. A lookup fell back; check these first ` +
                    `if the page behaves oddly.`,
                    surprising,
                );
            }

            pending.settle({
                ok: true,
                record: pending.record,
                url: data.url,
                documentUrl: data.documentUrl ?? '',
                redirectsTo: pending.redirectsTo,
                type: data.type,
                missing: data.missing ?? [],
                resolved,
                revoke: () => blobUrls.forEach(url => URL.revokeObjectURL(url)),
            });
            return;
        }

        if (data?.action === 'viewProgress') {
            // Dropped rather than shown: this is a view that has been
            // superseded, still running only so it can clean up after
            // itself.
            if (data.id !== latestViewId) return;

            // `done` clears rather than sitting at 100%. Non-null is what
            // means "loading", so leaving a finished report in place would
            // pin the overlay open over the page it just finished building.
            reportProgress(data.stage === 'done' ? null : {
                stage: data.stage,
                url: data.url ?? '',
                resolved: data.resolved ?? 0,
                total: data.total ?? 0,
            });

            return;
        }

        // Bytes for a request the page made at runtime. See fetchArchived.
        if (data?.action === 'readRecord:done') {
            const pending = pendingReads.get(data.id);
            if (!pending) return;
            pendingReads.delete(data.id);
            pending.settle(data.bytes ?? null);
            return;
        }

        if (data?.action === 'viewFatal') {
            const pending = pendingViews.get(data.id);
            if (!pending) return;
            pendingViews.delete(data.id);

            // A fatal never reaches `done`, so this is the only thing that
            // takes the overlay down on the failure path.
            if (data.id === latestViewId) reportProgress(null);

            pending.settle({
                ok: false,
                reason: data.reason ?? 'unreadable',
                url: data.url ?? '',
                errorName: data.errorName ?? 'Error',
                message: data.message ?? 'The page could not be rebuilt.',
            });
        }
    };

    // A worker that dies takes every view waiting on it. Failing them all is
    // the only honest option — none of them will ever get an answer.
    worker.onerror = (event) => {
        const message = typeof event === 'object' && event && 'message' in event
            ? String((event as { message?: unknown }).message ?? '')
            : '';

        // A dead worker builds nothing, so nothing is in progress.
        reportProgress(null);

        // Runtime reads die too, and a fetch that never settles hangs the
        // page that made it — worse than an error it can handle.
        for (const [id, read] of pendingReads) {
            pendingReads.delete(id);
            read.settle(null);
        }

        for (const [id, pending] of pendingViews) {
            pendingViews.delete(id);
            pending.settle({
                ok: false,
                reason: 'unreadable',
                url: '',
                errorName: 'WorkerError',
                message: message || 'The view worker stopped without reporting a reason.',
            });
        }

        // Dropped so the next view starts a fresh one rather than talking to
        // a corpse.
        viewWorker = null;
    };

    viewWorker = worker;

    return worker;
};

/** How a top-level navigation treats a 3xx that carries a body. */
export interface NavigateOptions {
    /**
     * Follow it like any other redirect. Undefined means "whatever the reader
     * chose" — prefs.followRedirectsWithBody, off until they say otherwise. The
     * "Follow →" button passes true for the one navigation it triggers, so a
     * chain of two interstitials does not ask twice.
     */
    followBodiedRedirects?: boolean;
}

const shouldFollowBodied = (options?: NavigateOptions): boolean =>
    options?.followBodiedRedirects ?? getPrefs().followRedirectsWithBody;

/**
 * Navigate to an archived url, as if the reader had followed a link.
 *
 * The url comes from inside the iframe — a clicked anchor, a submitted form, a
 * `location.href =` the rewriter redirected — so it is a real address on the
 * original site, not a blob url. Resolving it is the same nearest-capture rule a
 * subresource gets, with the current page's date as the target: following a link
 * from a 2019 page should land on the 2019 capture of its destination.
 *
 * A url the archive does not hold is FATAL rather than a notice. There is nothing
 * to show, and silently doing nothing when a reader clicks a link is the worst of
 * the options.
 */
export const navigateArchived = async (
    url: string,
    from: string | null,
    entries: WarcRecordEntries,
    options?: NavigateOptions,
): Promise<ViewOutcome> => {
    const near = from
        ? (findNearestRecord(entries, from, new Date().toISOString()).record?.dateArchived.toISOString()
            ?? new Date().toISOString())
        : new Date().toISOString();

    // A page the reader will look at, so a redirect with a body is shown rather
    // than skipped — unless they have said not to bother.
    const found = findNearestRecord(entries, url, near, { stopAtBodiedRedirect: !shouldFollowBodied(options) });

    if (!found.record) return navigationFailure(url, found);

    return viewArchivedRecord(found.record, entries, options);
};

/**
 * Turn a failed lookup into something a reader can act on.
 *
 * The url reported is the END of the redirect chain, not the one clicked. They
 * are the same in the ordinary case; when they differ, the clicked url is the
 * least useful of the two — "5amgirlfriend.neocities.org/navi/rose/garden.html
 * is not archived" is wrong and confusing when garden.html IS archived and it is
 * `garden`, two hops later, that is missing. The trail goes in the message so
 * neither fact is lost.
 */
const navigationFailure = (
    clicked: string,
    found: NearestRecordResult,
): Extract<ViewOutcome, { ok: false }> => {
    const trail = found.redirects.length > 0
        ? ` Followed ${[clicked, ...found.redirects].join(' → ')}.`
        : '';

    if (found.reason === 'redirect') {
        return {
            ok: false,
            reason: 'redirect',
            url: found.finalUrl,
            errorName: 'RedirectLoop',
            message: `That link redirects in a loop, or through more than ${MAX_REDIRECTS} hops.${trail}`,
        };
    }

    if (found.reason === 'no-payload') {
        return {
            ok: false,
            reason: 'no-payload',
            url: found.finalUrl,
            errorName: 'NoPayload',
            message: `That page is in the archive but was captured without a body.${trail}`,
        };
    }

    return {
        ok: false,
        reason: 'not-archived',
        url: found.finalUrl,
        errorName: 'NotArchived',
        message: `That page is not in the archives you have loaded.${trail}`,
    };
};

/**
 * Rebuild an archived record as a blob url that an iframe can show.
 *
 * Fatal failures come back as ok:false rather than throwing, so the caller has to
 * look at them. The one case handled here rather than in the worker is a record
 * with no body at all — there is no point starting a worker for it.
 */
export const viewArchivedRecord = async (
    record: WarcRecord,
    entries: WarcRecordEntries,
    options?: NavigateOptions,
): Promise<ViewOutcome> => {
    // A record picked directly — the timeline's View button — can itself be a
    // redirect. If it is the usual empty one, the reader wants the destination,
    // not an empty frame, so it is followed from this record's OWN date (that is
    // the capture they pointed at). If it has a body and they have not asked to
    // skip such pages, it is shown as it is, and `redirectsTo` carries where it
    // leads so the frame can offer to go there.
    const follow = shouldFollowBodied(options);
    const target = redirectTarget(record);
    let redirectsTo: string | null = null;

    if (target !== null) {
        if (follow || !redirectHasBody(record)) {
            const found = findNearestRecord(entries, target, record.dateArchived.toISOString(), {
                stopAtBodiedRedirect: !follow,
            });

            if (!found.record) {
                return navigationFailure(record.url, { ...found, redirects: [target, ...found.redirects] });
            }

            // Not recursion: findNearestRecord already walked the chain. What it
            // returned is either not a redirect, or a bodied redirect it stopped
            // at on purpose — in which case it says so.
            record = found.record;
            redirectsTo = found.redirectsTo ?? null;
        } else {
            redirectsTo = target;
        }
    }

    if (!record.payload) {
        return {
            ok: false,
            reason: 'no-payload',
            url: record.url,
            errorName: 'NoPayload',
            message: 'This capture stored no body — it is a revisit, a redirect, or a 304.',
        };
    }

    let worker: Worker;

    try {
        worker = getViewWorker();
    } catch (error) {
        return {
            ok: false,
            reason: 'unreadable',
            url: record.url,
            errorName: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
        };
    }

    const id = nextViewId++;

    // This view is now the one whose progress is worth reporting. Set before the
    // worker is told anything, so no message can arrive already stale.
    latestViewId = id;

    // Captured, because `record` is reassigned above when a redirect is followed
    // and the outcome must name what rendered, not what was asked for.
    const built = record;

    return new Promise<ViewOutcome>(settle => {
        pendingViews.set(id, { settle, entries, record: built, redirectsTo });
        worker.postMessage({ action: 'viewRecord', id, viewId: id, record: toPostedRecord(built) });
    });
};

// ---------------------------------------------------------------------------
// Runtime requests
// ---------------------------------------------------------------------------

/** One answer to a page's own fetch/XHR, from the archive rather than the network. */
export type ArchivedFetch =
    | { ok: true; url: string; status: number; contentType: string; bytes: ArrayBuffer }
    | { ok: false; url: string; reason: MissingReason };

interface PendingRead {
    settle: (bytes: ArrayBuffer | null) => void;
}

const pendingReads = new Map<number, PendingRead>();
let nextReadId = 1;

/**
 * Answer a request the PAGE made at runtime, out of the archive.
 *
 * The static rewriter only ever sees references written into the markup. A page
 * that builds a url in script and fetches it — a comment widget, a lazy image, a
 * JSON feed — reaches this instead, and without it those requests either hit the
 * live network or fail silently, which are the two worst options.
 *
 * Bytes come back through the view worker rather than being read here. Reading a
 * payload means de-chunking it, and that lives in the worker's view module; a
 * second copy on the main thread is a second thing to keep in step.
 */
export const fetchArchived = async (
    url: string,
    nearArchived: string,
    entries: WarcRecordEntries,
): Promise<ArchivedFetch> => {
    const found = findNearestRecord(entries, url, nearArchived);

    if (!found.record) {
        return { ok: false, url: found.finalUrl, reason: found.reason ?? 'not-archived' };
    }

    const record = found.record;

    if (!record.payload) return { ok: false, url: record.url, reason: 'no-payload' };

    let worker: Worker;

    try {
        worker = getViewWorker();
    } catch {
        return { ok: false, url: record.url, reason: 'unreadable' };
    }

    const id = nextReadId++;

    const bytes = await new Promise<ArrayBuffer | null>(settle => {
        pendingReads.set(id, { settle });
        worker.postMessage({ action: 'readRecord', id, record: toPostedRecord(record) });
    });

    if (!bytes) return { ok: false, url: record.url, reason: 'unreadable' };

    return {
        ok: true,
        url: record.url,
        status: record.http?.status ?? 200,
        contentType: record.http?.contentType ?? record.contentType ?? 'application/octet-stream',
        bytes,
    };
};
