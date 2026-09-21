'use client';

/**
 * Building the url tree: where a record's url puts it, and in what order.
 *
 * Everything here is pure structure — no React, no workers, no fetching. The
 * only state it touches is the WarcRecordEntries handed in.
 */

import { WarcRecord, WarcRecordEntries, WarcRecordTreeNode } from "./types";

type TreeUrlParts =
    | { rootSegment: string; rootUrl: string; segments: string[]; query: string }
    /** No place in a host-rooted tree, and why — the caller logs accordingly. */
    | { rejected: 'unparseable' | 'not-a-web-url' };

/**
 * Canonical form of a url's query string: the same parameters, keys sorted.
 *
 * Sorting is what makes a query usable as an identity. `?id=30&blocked=false`
 * and `?blocked=false&id=30` are one request written two ways, and a crawler
 * following links from different pages will produce both — unsorted they would
 * be two nodes for one page, each holding half of its captures.
 *
 * URLSearchParams.sort is a STABLE sort by key, so repeated keys keep their
 * relative order: `?a=2&a=1` stays `a=2&a=1` and does not collapse into
 * `?a=1&a=2`, which would be a different request. Returns '' for no query and
 * for a bare trailing '?', both of which mean "no parameters".
 */
const canonicalQuery = (url: URL): string => {
    // Most records have no query at all, and building a URLSearchParams to sort
    // nothing is the single most-executed pointless allocation on the parse path.
    // '?' alone means no parameters too, which is why the length test is > 1.
    if (url.search.length <= 1) return '';

    const params = new URLSearchParams(url.search);
    params.sort();

    return params.toString();
};

/**
 * One record url, parsed once, in the pieces BOTH trees need.
 *
 * The two trees used to parse the same string separately — `new URL`, a
 * `URLSearchParams` sort and a path split each, per tree, per record. That is
 * 14,000 URL parses for a 7,000-record container, and the query and the path
 * segments came out byte-identical every time; only the root differs.
 *
 * `segments` is SHARED between the two callers rather than copied. Safe because
 * placeInTree only ever iterates it — verified — and a copy per tree would put
 * back half of what this saves.
 */
interface ParsedRecordUrl {
    url: URL;
    segments: string[];
    query: string;
}

const parseRecordUrl = (rawUrl: string): ParsedRecordUrl | TreeUrlParts => {
    let url: URL;

    try {
        url = new URL(rawUrl);
    } catch {
        return { rejected: 'unparseable' };
    }

    // The weaker of the two host tests, so the normalized tree can still take
    // `onion:` and `i2p:`. The raw tree applies its own extra rule in rawPartsOf.
    if (!url.host) {
        return { rejected: 'not-a-web-url' };
    }

    return {
        url,
        segments: url.pathname.split('/').filter(Boolean),
        query: canonicalQuery(url),
    };
};

const isRejection = (parsed: ParsedRecordUrl | TreeUrlParts): parsed is TreeUrlParts =>
    'rejected' in parsed;

/**
 * Split a record url into the pieces the tree is keyed by.
 *
 * The host becomes the root node's segment while the root's url keeps the full
 * origin, so the tree reads as "example.com" but every node still carries a url
 * that can be navigated to. Path segments below that are the url's own segments,
 * and a query string, if any, becomes ONE further segment below the path:
 *
 *     forum.com/view/thread?id=10
 *     forum.com/view/thread?id=30&blocked=false
 *     forum.com/view/thread?action=lolno
 *
 *       -> forum.com
 *          -> view
 *             -> thread
 *                -> ?action=lolno
 *                -> ?blocked=false&id=30
 *                -> ?id=10
 *
 * Nested under the path rather than folded into it, so /view/thread's own
 * captures stay on `thread` and every variant of it is visibly a variant. The
 * query is NOT split into a node per parameter: `id` and `blocked` are not a
 * hierarchy, and pretending they are would put thread?id=10 and thread?id=30 in
 * different subtrees depending on which other parameters came along.
 *
 * This reverses the earlier rule that dropped the query entirely. That rule read
 * fine on a static site and fell apart on anything dynamic: a phpBB archive is
 * thousands of distinct pages behind one `viewtopic.php`, and collapsing them
 * gave a tree with one leaf holding every record and no way to tell them apart.
 *
 * Fragments are still excluded, and unconditionally — a fragment never reaches a
 * server, so it cannot identify a separate capture.
 *
 * Never throws. This runs once per record on the parse hot path, and one odd
 * WARC-Target-URI should cost that record its place in the tree, not kill the
 * parse — hence a result rather than an exception.
 */
const rawPartsOf = (parsed: ParsedRecordUrl): TreeUrlParts => {
    // `new URL` accepts far more than web addresses, and a crawler writes plenty
    // of them: wget and Heritrix both emit "dns:example.com" resource records,
    // and metadata records often carry a "urn:" target. For any scheme the URL
    // spec calls non-special, `origin` is the literal string "null" and `host`
    // is empty — so rooting one anyway produces a node captioned with nothing,
    // at the url "null/", collecting every such record under it. Better to leave
    // them out of the tree than to invent a root that does not exist.
    //
    // The `!host` half of that test now lives in parseRecordUrl, which both trees
    // share. This is the extra rule only the raw tree applies.
    if (parsed.url.origin === 'null') {
        return { rejected: 'not-a-web-url' };
    }

    return {
        rootSegment: parsed.url.host,
        // Trailing slash: "https://example.com/" is the home page's own url,
        // so the root node is addressable rather than a bare prefix.
        rootUrl: `${parsed.url.origin}/`,
        segments: parsed.segments,
        query: parsed.query,
    };
};

/**
 * Find the node for `url`, creating and linking it if this is the first time it
 * has been seen. `parentChildren` is the array the node belongs in when new.
 */
/** Mark a node changed, so the row rendering it knows to re-read. */
export const bumpTreeVersion = (entries: WarcRecordEntries, url: string) => {
    entries.treeVersions.set(url, (entries.treeVersions.get(url) ?? 0) + 1);

    // Recording WHICH node changed is what lets the store wake only that node's
    // row. A Set, so a node touched fifty times in one frame is woken once.
    entries.dirtyTreeUrls.add(url);
};

/** Version key for the root list, which is not itself a node. */
export const TREE_ROOTS_KEY = '';

/**
 * Bumped whenever ANY node is created, anywhere in the tree.
 *
 * The tree renders as a flattened, windowed list, so one component decides
 * which rows exist — and it has to be told when the shape changes, not just
 * when one node's own contents did. Per-node versions cannot answer that: a new
 * node three levels down changes what the flat list contains without touching
 * any url the list is currently watching.
 *
 * A control character, so it cannot collide with a real url the way '' nearly
 * did with the roots key.
 *
 * The normalized tree has its OWN, below. Sharing one key would wake both
 * flattened lists on every record, and only one of them is ever on screen.
 */
export const TREE_SHAPE_KEY = '\u0000shape';

/** The same, for the normalized tree. See the note above on why it is separate. */
export const NORMAL_TREE_SHAPE_KEY = `${TREE_SHAPE_KEY}:normal`;

/**
 * The key that wakes anything showing a total, bumped by every record accepted.
 *
 * A separate key rather than reusing a shape key, because the two answer different
 * questions: a second capture of a url already in the tree changes the count and
 * not the shape, so a count watching TREE_SHAPE_KEY would sit still while records
 * poured in.
 *
 * And a KEY rather than the store's global emit, because that is what the split
 * store exists to avoid — a whole-world wake per frame during a parse. One keyed
 * listener wakes one small component.
 *
 * NUL-prefixed like the shape keys, and for the same reason: no url can contain
 * one, so the key cannot collide with a node.
 */
export const RECORD_COUNT_KEY = '\u0000count';

/**
 * One tree: its roots, its node index, and the key that says its shape moved.
 *
 * Passed as a bundle because the three always move together — a node is created
 * in the index and linked into the roots in the same breath, and having one
 * without the other is either a node nothing can find or a link to nothing.
 */
export interface WarcTreeTarget {
    roots: WarcRecordTreeNode[];
    index: Map<string, WarcRecordTreeNode>;
    /** segment -> every node with that segment. See WarcRecordEntries.segments. */
    segments: Map<string, WarcRecordTreeNode[]>;
    /** content type -> every node holding a record of it. See entries.contentTypes. */
    types: Map<string, Set<WarcRecordTreeNode>>;
    shapeKey: string;
}

/**
 * Every node holding a record of `type`.
 *
 * The type is compared exactly, not by substring: these come from a dropdown
 * built out of the index itself, so there is nothing to guess at. `record
 * .contentType` is already the bare, lowercased base type — wire.ts splits the
 * parameters off at parse time — so "text/html; charset=utf-8" and "TEXT/HTML"
 * arrive here as one key without any work happening on this path.
 */
export const findTreeContentType = (
    type: string,
    types: Map<string, Set<WarcRecordTreeNode>>,
): WarcRecordTreeNode[] => [...(types.get(type) ?? [])];

/**
 * Every content type in the archive, alphabetically, with how many nodes hold one.
 *
 * Sorted here rather than at render, because the dropdown rebuilds whenever the
 * shape moves and a parse moves it constantly.
 */
/**
 * Cached, for the same reason segmentCollator below is.
 *
 * `String.prototype.localeCompare` constructs a fresh collator on every call, so
 * the sort that used it paid for one per comparison — O(n log n) collators to
 * order a few dozen content types, on a list that used to be rebuilt every
 * animation frame during a parse.
 *
 * No `numeric` here, unlike segmentCollator: a content type has no digit runs
 * worth comparing as numbers, and "base" sensitivity is enough to put
 * "TEXT/HTML" beside "text/html" — though wire.ts has already lowercased both.
 */
const typeCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

export const listContentTypes = (
    types: Map<string, Set<WarcRecordTreeNode>>,
): { type: string; nodes: number }[] =>
    [...types.entries()]
        .map(([type, nodes]) => ({ type, nodes: nodes.size }))
        .sort((a, b) => typeCollator.compare(a.type, b.type));

/**
 * A node's parent url, derived from its own.
 *
 * Nodes carry no parent pointer, deliberately — WarcRecordTreeNode is a plain
 * shape and a back-reference would make it cyclic. It does not need one: a
 * child's url IS its parent's url plus a segment, so the link is already there
 * to be read.
 *
 * Returns null at a root, which is any url ending in `/`.
 */
export const parentUrlOf = (url: string): string | null => {
    // A query node hangs off the path node it decorates, so its parent is
    // whatever comes before the '?' — not one path segment up.
    const query = url.indexOf('?');
    if (query > 0) return url.slice(0, query);

    if (url.endsWith('/')) return null;

    const cut = url.lastIndexOf('/');
    if (cut < 0) return null;

    const parent = url.slice(0, cut);

    /*
     * A root node's url carries a trailing slash — "https://a.com/", "a.com/" —
     * so cutting the last segment off "https://a.com/navi" lands one character
     * short of it and the ancestor walk falls off the top of the tree.
     *
     * The test is whether anything is left after the authority. Counting slashes
     * on the whole string does not work: the "//" of a scheme is two of them
     * before any path has begun, which is why the first attempt here matched
     * "a.com/navi" and not "https://a.com".
     */
    const scheme = parent.indexOf('://');
    const authority = scheme < 0 ? parent : parent.slice(scheme + 3);

    return authority.includes('/') ? parent : `${parent}/`;
};

/**
 * Every node whose segment contains `query`, case-insensitively.
 *
 * The reason the segment index exists. Searching the tree itself means walking
 * every node on every keystroke — tens of thousands on a real archive — where
 * this walks the DISTINCT segments, of which there are far fewer, and hands back
 * the nodes directly.
 *
 * Nodes rather than records: the same segment appears under hundreds of
 * different parents, so `index.html` as a bag of records is an undifferentiated
 * pile with no way to say where any of it came from. A node knows its url, its
 * own records, and — through parentUrlOf — its whole ancestry.
 */
export const findTreeSegments = (
    query: string,
    segments: Map<string, WarcRecordTreeNode[]>,
): WarcRecordTreeNode[] => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];

    const found: WarcRecordTreeNode[] = [];

    for (const [segment, nodes] of segments) {
        if (segment.toLowerCase().includes(needle)) found.push(...nodes);
    }

    return found;
};

/**
 * The nodes in both of two match sets.
 *
 * A text query and a content type are an AND, not an OR: "show me the images"
 * plus "called banner" means the images called banner. Either alone is handled
 * by passing null for the other, so the caller never has to special-case which
 * filters happen to be active.
 */
export const intersectMatches = (
    a: readonly WarcRecordTreeNode[] | null,
    b: readonly WarcRecordTreeNode[] | null,
): readonly WarcRecordTreeNode[] | null => {
    if (a === null) return b;
    if (b === null) return a;

    // The smaller side drives the scan, and the larger becomes the Set.
    const [few, many] = a.length <= b.length ? [a, b] : [b, a];
    const lookup = new Set(many);

    return few.filter(node => lookup.has(node));
};

/** What a search leaves visible: the matches, and the path down to each. */
export interface TreeFilter {
    /** Every url allowed to appear — matches plus their ancestors. */
    keep: Set<string>;
    /** The matches themselves. Below one of these, nothing is filtered. */
    matched: Set<string>;
}

/**
 * Turn a set of matching nodes into something the flattener can render.
 *
 * Ancestors are walked UP from each match rather than down from the roots, which
 * is the whole point: that is O(matches x depth) — depth is 8 on the widest
 * archive here — against O(every node in the tree) for a filter that descends.
 */
export const treeFilterFor = (
    matches: readonly WarcRecordTreeNode[],
    index: Map<string, WarcRecordTreeNode>,
): TreeFilter => {
    const keep = new Set<string>();
    const matched = new Set<string>();

    for (const node of matches) {
        matched.add(node.url);

        let at: string | null = node.url;

        // Bounded rather than trusting the walk to terminate: the urls come from
        // the tree, but parentUrlOf is string arithmetic and a malformed one
        // should cost a missing ancestor, not a hung tab.
        for (let step = 0; at !== null && step < 64; step++) {
            if (keep.has(at)) break;
            keep.add(at);
            at = parentUrlOf(at);
        }
    }

    // Only ancestors that are real nodes. A url derived by string arithmetic can
    // name something the tree never created.
    for (const url of [...keep]) {
        if (!index.has(url)) keep.delete(url);
    }

    return { keep, matched };
};

/**
 * A host with its `www.` stripped.
 *
 * The LABEL, not the prefix. `wwwfoo.example.com` is a different site from
 * `foo.example.com`, and a `startsWith('www')` would merge them — so the dot is
 * part of the match.
 *
 * The host arrives already lowercased from the URL parser. The PORT is gone
 * before this is called — see normalTreeUrlParts, which reads `hostname` rather
 * than `host`.
 */
export const normalizeTreeHost = (host: string): string =>
    host.startsWith('www.') ? host.slice(4) : host;

/**
 * The same url, addressed by host and path alone.
 *
 * Drops the scheme entirely, which is the point: `http://www.example.com` and
 * `https://example.com` are one site a reader is trying to look at, and in the
 * raw tree they are two roots that never meet.
 *
 * Accepts schemes the raw tree REFUSES. `treeUrlParts` rejects anything whose
 * `origin` is the string "null" — which is every scheme the URL spec calls
 * non-special, and that includes `onion:` and `i2p:`. Those have real hosts and
 * are exactly the addresses this tree exists to show, so the test here is "has a
 * host" rather than "has an origin". `dns:example.com` still has no host, so it
 * is still left out of both trees.
 */
export const normalPartsOf = (parsed: ParsedRecordUrl): TreeUrlParts => {
    // `hostname`, not `host`: the difference is the port, and dropping it is the
    // same call as dropping the scheme. `https://example.com` and
    // `https://example.com:8443` are one site reached two ways, and a reader
    // looking for a page does not care which socket served it. The raw tree still
    // keeps them apart, which is where to look when the port is the question.
    //
    // Also correct for a bracketed IPv6 literal, which `hostname` returns intact
    // as `[::1]` — the brackets are part of the name, and only the `:8443` after
    // them is the port.
    const host = normalizeTreeHost(parsed.url.hostname);

    return {
        rootSegment: host,
        // A trailing slash like the raw tree, so the root is the home page's own
        // address rather than a bare prefix. No scheme in front of it — which is
        // also what keeps these keys from colliding with the raw tree's in the
        // shared treeVersions map, since every one of those carries a scheme.
        rootUrl: `${host}/`,
        segments: parsed.segments,
        query: parsed.query,
    };
};

/**
 * A-Z, with runs of digits compared as numbers.
 *
 * `numeric` is the part that matters for an archive: a board thread directory
 * holds 2.html, 10.html, 774138.html, and plain string order puts 10 before 2.
 * Case-insensitive because a reader scanning for "Assets" should not have to
 * know whether the crawler wrote it capitalised.
 *
 * Built once. Intl.Collator compiles its rules on construction, so calling
 * localeCompare with options inline would rebuild that on every comparison —
 * roughly log2(siblings) times per record inserted.
 */
const segmentCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Ordering for sibling nodes. The tiebreak is not decoration — it is what makes
 * the order a function of the data rather than of arrival order.
 *
 * Two things tie on segment. The collator calls "About" and "about" equal, and
 * more importantly two ROOTS can have the same segment outright: the root's
 * segment is the host, so https://crystal.cafe/ and http://crystal.cafe/ are
 * different origins with identical segments. crystal.cafe.warc contains both, plus
 * http://www.crystal.cafe/ — nine roots for what a reader thinks of as one site.
 *
 * So the tiebreak is on `url`, which is unique by construction: it is the key each
 * node is stored under in recordTreeIndex, so no two siblings can share one.
 */
const compareSegments = (a: WarcRecordTreeNode, b: WarcRecordTreeNode): number =>
    segmentCollator.compare(a.segment, b.segment) ||
    (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);

/**
 * Add a node to an already-sorted sibling list, keeping it sorted.
 *
 * Sorting on insert rather than on render, because a render-time sort would
 * rebuild the array on every re-render of every node forever, while the order
 * only ever changes when something is added. And inserted rather than
 * push-then-sort: a crawl of a large site puts thousands of siblings under one
 * directory, and re-sorting that per record is O(n log n) on the parse hot path
 * where a binary search is O(log n) comparisons plus one memmove.
 */
const insertSorted = (siblings: WarcRecordTreeNode[], node: WarcRecordTreeNode) => {
    let low = 0;
    let high = siblings.length;

    while (low < high) {
        const mid = (low + high) >>> 1;

        if (compareSegments(siblings[mid]!, node) <= 0) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    siblings.splice(low, 0, node);
};

const ensureTreeNode = (
    entries: WarcRecordEntries,
    tree: WarcTreeTarget,
    url: string,
    segment: string,
    parentChildren: WarcRecordTreeNode[],
    parentUrl: string,
): WarcRecordTreeNode => {
    const existing = tree.index.get(url);

    if (existing) {
        return existing;
    }

    const node: WarcRecordTreeNode = { segment, url, records: [], children: [] };

    tree.index.set(url, node);

    // The search index, filled HERE rather than by a later pass over the tree:
    // this is the one place a node comes into existence, so the two cannot drift
    // and nothing has to be rebuilt when records arrive mid-parse.
    const sharing = tree.segments.get(segment);
    if (sharing) sharing.push(node);
    else tree.segments.set(segment, [node]);

    insertSorted(parentChildren, node);

    // The PARENT changed, not this node — it gained a child. Bumping the parent
    // is what re-renders the row whose <ul> has to grow; the new node has no row
    // yet to notify. This covers reordering too: an insert in the middle shifts
    // its siblings, and the parent's row is the one that re-maps them. The rows
    // themselves are keyed by url, so React moves them rather than rebuilding.
    bumpTreeVersion(entries, parentUrl);

    // And the flat list, which cares that a node exists at all. This tree's own
    // shape key, so a record landing in one does not re-flatten the other.
    bumpTreeVersion(entries, tree.shapeKey);

    return node;
};

/**
 * WARC types that legitimately carry no WARC-Target-URI.
 *
 * Per WARC 1.1 the field is MANDATORY on response, request, resource, revisit,
 * conversion and continuation; it is optional on metadata; and warcinfo — the
 * block that opens every file, describing the crawl rather than any page — has
 * no target by definition.
 *
 * So this set is the line between "expected" and "bug". Blanket-silencing a
 * missing url would be easier and wrong: the loud error below is what caught the
 * worker's output never being mapped into a WarcRecord, a failure whose only
 * other symptom was a tree that quietly stopped growing.
 */
const TYPES_WITHOUT_TARGET_URI = new Set<string>(['warcinfo', 'metadata']);

/**
 * File a record into the url tree, creating whatever ancestors are missing.
 *
 *     https://example.com/assets/style.css
 *       -> example.com          (https://example.com/)
 *          -> assets            (https://example.com/assets)
 *             -> style.css      (https://example.com/assets/style.css)
 *
 * Intermediate nodes are created whether or not anything captured them — nothing
 * ever archives the `assets` directory itself, but the tree still needs it to
 * hang style.css off, so it exists with an empty `records`. That is how you tell
 * a directory apart from a page: an empty records array.
 *
 * Cost is one Map lookup per path segment, so it does not degrade as the tree
 * widens. The record is appended to the deepest node only; ancestors keep just
 * their own captures.
 *
 * @returns whether the record found a node. False is not necessarily an error —
 * see TYPES_WITHOUT_TARGET_URI — so the caller stores the record either way and
 * uses this only to decide WHERE.
 */
export const pushRecordIntoTree = (record: WarcRecord, entries: WarcRecordEntries): boolean => {
    if (typeof record.url !== 'string' || record.url === '') {
        // Normal for the types above: a warcinfo opens every WARC, so shouting
        // about it meant one console.error per file per parse, which is exactly
        // the volume that trains you to ignore the console. Any other type is
        // required to carry a url, so its absence means the record was never
        // mapped properly — a bug in this file, not in the archive.
        if (!TYPES_WITHOUT_TARGET_URI.has(record.type)) {
            console.error('pushRecord: record has no url, so it cannot be placed in the tree', record);
        }

        return false;
    }

    // ONE parse, both trees. They differ only in the root they derive, so the
    // expensive part — new URL, the query sort, the path split — is done once and
    // projected twice. See parseRecordUrl.
    const parsed = parseRecordUrl(record.url);

    // Unparseable, or hostless like `dns:example.com`: neither tree can take it,
    // and there is nothing to project. Handed to placeInTree anyway rather than
    // returned early, because placeInTree owns the "why was this refused" logging
    // and that message should not now come from two places.
    if (isRejection(parsed)) {
        return placeInTree(record, entries, parsed, {
            roots: entries.recordTree,
            index: entries.recordTreeIndex,
            segments: entries.segments,
            types: entries.contentTypes,
            shapeKey: TREE_SHAPE_KEY,
        });
    }

    // BOTH trees, from one record. They differ only in how a url is split, so
    // the placement below is shared and each gets its own roots and index.
    //
    // Not the same set of records, deliberately: `onion://` and `i2p://` have a
    // host but no origin, so the raw tree turns them away and the normalized one
    // takes them. A record can therefore land in one, the other, or both.
    //
    // Two separate calls rather than an array literal + .some(): the array was one
    // allocation per record for a boolean OR, and `||` cannot be used because both
    // placements must happen.
    const inRaw = placeInTree(record, entries, rawPartsOf(parsed), {
        roots: entries.recordTree,
        index: entries.recordTreeIndex,
        segments: entries.segments,
        types: entries.contentTypes,
        shapeKey: TREE_SHAPE_KEY,
    });

    const inNormal = placeInTree(record, entries, normalPartsOf(parsed), {
        roots: entries.normalTree,
        index: entries.normalTreeIndex,
        segments: entries.normalSegments,
        types: entries.normalContentTypes,
        shapeKey: NORMAL_TREE_SHAPE_KEY,
    });

    // Untreeable only when NEITHER would have it. A record the normalized tree
    // can show is not lost, whatever the raw one thinks of its scheme.
    return inRaw || inNormal;
};

/**
 * Put one record into one tree, given how its url splits.
 *
 * Split out of pushRecordIntoTree so the two trees cannot drift: the node
 * building, the sorting, the version bumps and the query handling are all
 * identical, and the ONLY difference between them is which `TreeUrlParts` they
 * were handed.
 */
const placeInTree = (
    record: WarcRecord,
    entries: WarcRecordEntries,
    parts: TreeUrlParts,
    tree: WarcTreeTarget,
): boolean => {
    if ('rejected' in parts) {
        // "dns:example.com" and friends are records a crawler wrote on purpose,
        // so they are stored and skipped quietly. A url that would not parse at
        // all is worth a line — it is either a crawler emitting something odd or
        // this file mangling it on the way in, and both are worth seeing.
        //
        // Reported for the RAW tree only. The two are handed the same url, so
        // saying it twice per record would double a warning that is already
        // about the url rather than about either tree.
        if (parts.rejected === 'unparseable' && tree.shapeKey === TREE_SHAPE_KEY) {
            console.warn(`pushRecord: unparseable url, record kept but left out of the tree: ${record.url}`);
        }

        return false;
    }

    let node = ensureTreeNode(entries, tree, parts.rootUrl, parts.rootSegment, tree.roots, TREE_ROOTS_KEY);

    // Built from the origin so each level's url is the real url of that path,
    // not a string assembled from the parent's (which carries a trailing slash
    // at the root and would double up).
    let url = parts.rootUrl.slice(0, -1);

    for (const segment of parts.segments) {
        const parentUrl = node.url;
        url = `${url}/${segment}`;
        node = ensureTreeNode(entries, tree, url, segment, node.children, parentUrl);
    }

    if (parts.query) {
        // Built from the PARENT NODE's url rather than from the `url` accumulator,
        // which carries no trailing slash and so would produce
        // "https://forum.com?page=2" for a query on the site root — a url that
        // does not match the root node's own "https://forum.com/".
        const parentUrl = node.url;

        node = ensureTreeNode(
            entries,
            tree,
            `${parentUrl}?${parts.query}`,
            // The '?' is kept in the label so a query variant is unmistakably one
            // rather than looking like a path segment called "id=10".
            `?${parts.query}`,
            node.children,
            parentUrl,
        );
    }

    node.records.push(record);

    /*
     * The content-type index, keyed on the record and stored against the NODE.
     *
     * A Set rather than an array: one node commonly holds several captures of
     * one page, and a node that appeared once per matching record would be
     * listed ten times in a filter that wants it once.
     *
     * Empty types are skipped. A request record and a warcinfo carry none, and
     * a "" entry in the dropdown is a row a reader cannot act on.
     */
    if (record.contentType !== '') {
        const holding = tree.types.get(record.contentType);

        if (holding) holding.add(node);
        else tree.types.set(record.contentType, new Set([node]));
    }

    // This node's own contents changed — its record count moved.
    bumpTreeVersion(entries, node.url);

    return true;
}

// ---------------------------------------------------------------------------
// Flattening, for the windowed renderer
// ---------------------------------------------------------------------------

/** One row of the rendered tree: a node, and how deep it sits. */
export interface FlatTreeRow {
    node: WarcRecordTreeNode;
    depth: number;
}

/**
 * The rows a reader can currently see, in the order they appear.
 *
 * The tree renders as a FLAT windowed list rather than nested <ul>s, because a
 * fully expanded archive is 13,630 nodes and mounting all of them is seconds of
 * first paint and a lot of memory. Flat means every row is one line of known
 * height, which is what makes a window computable at all — and the tree stays
 * an exhaustive record view, because nothing is hidden, only unmounted while
 * scrolled away.
 *
 * Iterative rather than recursive: the depth is bounded (8 on the widest
 * archive here) but the total is not, and a stack is the same code without the
 * question.
 *
 * `isOpen` is passed in rather than read from a store, so this is a pure
 * function of the tree and the open set — which is what lets it be tested
 * without mounting anything.
 */
export const flattenVisibleTree = (
    roots: WarcRecordTreeNode[],
    isOpen: (url: string) => boolean,
    filter?: TreeFilter,
): FlatTreeRow[] => {
    const rows: FlatTreeRow[] = [];

    /**
     * `free` means "stop filtering below here".
     *
     * A search shows the path down to each match and then the match's whole
     * subtree. Without the flag the filter would also have to enumerate every
     * descendant of every match, which is the tree walk this exists to avoid —
     * and it would hide the children of the very node the reader searched for.
     */
    interface Pending extends FlatTreeRow { free: boolean }

    // Reversed, so popping yields the original order.
    const stack: Pending[] = [];

    for (let i = roots.length - 1; i >= 0; i--) {
        stack.push({ node: roots[i]!, depth: 0, free: filter === undefined });
    }

    while (stack.length > 0) {
        const row = stack.pop()!;

        if (!row.free && !filter!.keep.has(row.node.url)) continue;

        rows.push({ node: row.node, depth: row.depth });

        if (row.node.children.length === 0 || !isOpen(row.node.url)) continue;

        const free = row.free || (filter !== undefined && filter.matched.has(row.node.url));

        for (let i = row.node.children.length - 1; i >= 0; i--) {
            stack.push({ node: row.node.children[i]!, depth: row.depth + 1, free });
        }
    }

    return rows;
};

/** Height of one tree row in pixels. The window maths depends on it being exact. */
export const TREE_ROW_HEIGHT = 36;

/** Rows rendered beyond each edge of the viewport, so scrolling does not flicker. */
export const TREE_OVERSCAN = 8;

/**
 * The slice of `total` rows to render for a viewport of `height` at `scrollTop`.
 *
 * Clamped at both ends: a container that has not measured yet reports height 0,
 * and an over-scrolled container (elastic scrolling, or a list that just shrank)
 * reports a scrollTop past the end.
 */
export const windowRange = (total: number, scrollTop: number, height: number) => {
    const visible = Math.ceil(height / TREE_ROW_HEIGHT) + TREE_OVERSCAN * 2;
    const first = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
    const start = Math.min(first, Math.max(0, total - 1));

    return { start, end: Math.min(total, start + Math.max(visible, 1)) };
};
