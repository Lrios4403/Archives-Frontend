'use client';

import type { CSSProperties } from "react";
import { createContext, memo, ReactNode, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { WarcRecordContext } from "./context";
import { canSaveToFile, startDownload, suggestedFileName } from "./download";
import WarcOfflineRecordListingTimeline, { WarcOfflineRecordActions } from "./recordListingTimeline";
import { createKeyedListeners, createListeners, neverSubscribe } from "./store";
import {
    TREE_ROW_HEIGHT,
    NORMAL_TREE_SHAPE_KEY,
    TREE_SHAPE_KEY,
    findTreeContentType,
    findTreeSegments,
    flattenVisibleTree,
    intersectMatches,
    listContentTypes,
    treeFilterFor,
    windowRange,
    type FlatTreeRow,
    type TreeFilter,
} from "./tree";
import { countResponseRecords, WarcRecordTreeNode, WarcTreeVersions } from "./types";
import { focusArchiveViewer } from "./viewerFocus";
import shared from "./Offline.module.css";
import s from "./recordListingTree.module.css";

/** The picker, which lives on window and not in any lib this project loads. */
interface WindowWithSavePicker extends Window {
    showSaveFilePicker?: (options: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
}

/**
 * Per-node change signal, held separately from WarcRecordContext.
 *
 * WarcRecordContext gets a new snapshot on every flush, so a row consuming it
 * would re-render whenever anything anywhere changed — thousands of rows per
 * frame during a parse. This context holds one object that never changes
 * identity, so consuming it costs a row nothing; what wakes a row is its own
 * subscription to its own url's version.
 */
const WarcTreeVersionsContext = createContext<WarcTreeVersions | undefined>(undefined);

interface WarcTreeExpansion {
    /** Keyed per url, for the reason given on WarcTreeVersions.subscribeTo. */
    subscribeTo: (url: string) => (listener: () => void) => () => void;
    isOpen: (url: string) => boolean;
    toggle: (url: string) => void;

    /**
     * Any toggle at all, for the one component that has to know: the flat list.
     *
     * Opening a node changes which ROWS exist, not just that node's bracket, so
     * the renderer cannot get by on per-url subscriptions the way the rows can.
     */
    subscribeAny: (listener: () => void) => () => void;
    version: () => number;
}

// Which nodes are expanded is owned by the tree root, not by each item.
//
// A closed parent unmounts its children — that is deliberate, and it is what
// keeps a tree of tens of thousands of URLs cheap — but an item holding its own
// `open` flag loses that flag along with the unmount, so reopening a parent
// collapsed everything underneath it. Keyed by url here, the state outlives the
// unmount and the subtree comes back exactly as it was left.
//
// The context carries a store rather than the state itself, and never changes
// identity. Holding the open set as React state would mean a new context value
// per toggle, which re-renders every mounted row — thousands of them, to move
// one bracket. Each row instead subscribes to its own boolean, so opening a node
// re-renders that node and nothing else.
const WarcTreeExpansionContext = createContext<WarcTreeExpansion | undefined>(undefined);

interface WarcTreeTimeline {
    subscribeTo: (url: string) => (listener: () => void) => () => void;
    isOpen: (url: string) => boolean;
    /**
     * Is ANY panel open — a different question from whether a given row's is, and
     * the one the scroll pane asks so it can make room for the panel.
     */
    subscribeAny: (listener: () => void) => () => void;
    hasOpen: () => boolean;
    toggle: (url: string) => void;
    close: () => void;
}

/**
 * Which node's response panel is showing. At most ONE, deliberately.
 *
 * The panel is an overlay — it covers the rows below it — so two open at once
 * would render one on top of the other with no way to tell which belongs to
 * which node. Opening a second therefore closes the first.
 *
 * Same store-in-context shape as expansion above, and for the same reason: a row
 * subscribes to its own boolean, so a toggle re-renders the row that opened and
 * the row that closed, and no others.
 */
const WarcTreeTimelineContext = createContext<WarcTreeTimeline | undefined>(undefined);

const createWarcTreeTimeline = (): WarcTreeTimeline => {
    let openUrl: string | null = null;

    const { subscribeTo, emitEach } = createKeyedListeners();
    const { subscribe: subscribeAny, emit: emitAny } = createListeners();

    // Exactly the rows whose answer can have changed: the one closing and the one
    // opening. Undefined entries are skipped, so this also covers the first open
    // and the final close.
    const changed = (from: string | null, to: string | null) => {
        emitEach([from, to].filter((url): url is string => url !== null));

        // Only when the BOOLEAN flips. Moving a panel from one row to another
        // leaves "something is open" true, and the pane does not need to hear
        // about it — this fires on the first open and the last close, not on
        // every toggle in between.
        if ((from === null) !== (to === null)) emitAny();
    };

    return {
        subscribeTo,
        isOpen: (url) => openUrl === url,
        subscribeAny,
        hasOpen: () => openUrl !== null,

        toggle: (url) => {
            const previous = openUrl;
            openUrl = previous === url ? null : url;
            changed(previous, openUrl);
        },

        close: () => {
            if (openUrl === null) return;

            const previous = openUrl;
            openUrl = null;
            changed(previous, null);
        },
    };
};

/**
 * The per-row indent, as a custom property rather than a table of style objects.
 *
 * This used to be `DEPTH_INDENT`: sixteen pre-built `{ paddingLeft: depth * 14 }`
 * objects, hoisted so that a row did not allocate one per render. The objects
 * are still one per row, but they now carry a NUMBER rather than a layout value,
 * and `.rowWrap` turns it into `calc(var(--depth) * var(--warc-indent))`.
 *
 * Two things fall out of that. The depth cap is gone — the old table silently
 * stopped indenting past depth 15 — and the indent width is one token instead of
 * a literal baked into sixteen objects.
 */
const DEPTH_VARS = Array.from(
    { length: 16 },
    (_, depth) => ({ '--depth': depth }) as CSSProperties,
);

const indentFor = (depth: number): CSSProperties =>
    DEPTH_VARS[depth] ?? ({ '--depth': depth } as CSSProperties);


const createWarcTreeExpansion = (): WarcTreeExpansion => {
    /**
     * What is open. Everything starts closed.
     *
     * This used to be seeded by walking the ENTIRE tree depth-first looking for
     * `node.isExpanded` — a field the tree builder never set, on any node, ever.
     * So the walk visited every node in the archive at provider mount and always
     * returned an empty Set. Removed along with the field; if a default-open
     * state is ever wanted, it belongs here rather than smuggled through the
     * node shape.
     */
    const openUrls = new Set<string>();

    const { subscribeTo, emit } = createKeyedListeners();

    // A second, unkeyed channel for the flat list. Counted rather than flagged
    // so useSyncExternalStore has something to compare.
    const anyListeners = new Set<() => void>();
    let version = 0;

    return {
        subscribeTo,

        subscribeAny: (listener) => {
            anyListeners.add(listener);
            return () => { anyListeners.delete(listener); };
        },

        version: () => version,

        // Mutated in place, which is safe precisely because nothing compares the
        // Set: rows read a boolean out of it and are woken by the subscription.
        isOpen: (url) => openUrls.has(url),

        toggle: (url) => {
            if (!openUrls.delete(url)) {
                openUrls.add(url);
            }

            version++;

            // The row, so its bracket flips; and the list, because the rows
            // underneath it just appeared or vanished.
            emit(url);
            anyListeners.forEach(listener => listener());
        },
    };
};

/**
 * Owns expansion for every item rendered underneath it. Exported so the item
 * can be mounted outside the default tree; without a provider above it an item
 * renders collapsed and shows no toggle, since there would be nowhere to record
 * the toggle's effect.
 */
export function WarcTreeExpansionProvider({
    children,
}: {
    children: ReactNode;
}) {
    // Created once, so a later tree — records parsed, a file added — does not
    // reset what the reader has already opened.
    const [expansion] = useState(createWarcTreeExpansion);

    return (
        <WarcTreeExpansionContext.Provider value={expansion}>
            {children}
        </WarcTreeExpansionContext.Provider>
    );
}

/**
 * Whether this one url is open. The snapshot is a boolean, so a toggle wakes
 * every row but only re-renders the ones whose own answer actually changed.
 */
const useIsOpen = (expansion: WarcTreeExpansion | undefined, url: string, fallback: boolean) => {
    // Memoised on [store, url] so the subscribe identity is stable across
    // renders. createKeyedListeners also caches per key, so this is belt and
    // braces — but useSyncExternalStore tearing down and rebuilding a
    // subscription on every render would be worse than the fan-out it replaced,
    // and that is too quiet a failure to leave to one layer.
    const subscribe = useMemo(
        () => expansion?.subscribeTo(url) ?? neverSubscribe,
        [expansion, url],
    );

    return useSyncExternalStore(
        subscribe,
        () => expansion?.isOpen(url) ?? fallback,
        // The server has no store to read, and the client's seed is this same
        // field, so the two agree and hydration stays quiet.
        () => fallback,
    );
};

/**
 * How many times this node's own contents changed.
 *
 * Nodes are mutated in place, so `node` never changes identity and neither props
 * nor the memo below can tell that a record landed on it. This number is the
 * only signal that it did, and reading it as the row's snapshot is what makes
 * "re-render this row" mean exactly that.
 */
const useNodeVersion = (versions: WarcTreeVersions | undefined, url: string) => {
    const subscribe = useMemo(
        () => versions?.subscribeTo(url) ?? neverSubscribe,
        [versions, url],
    );

    return useSyncExternalStore(
        subscribe,
        () => versions?.versionOf(url) ?? 0,
        () => 0,
    );
};

/** Whether this node's response panel is the open one. */
const useTimelineOpen = (timeline: WarcTreeTimeline | undefined, url: string) => {
    const subscribe = useMemo(
        () => timeline?.subscribeTo(url) ?? neverSubscribe,
        [timeline, url],
    );

    return useSyncExternalStore(
        subscribe,
        () => timeline?.isOpen(url) ?? false,
        // Always closed on the server: the panel is an overlay opened by a click,
        // so rendering it into the HTML would flash it before hydration.
        () => false,
    );
};

/**
 * View/Download for every panel in the tree, held in context rather than passed
 * down. A row does not know or care what viewing a capture means; threading two
 * callbacks through every level of a recursive component to reach a panel that
 * may never open would put them in the props of thousands of rows.
 *
 * Empty by default, which is what makes the panel's buttons render disabled.
 */
const WarcOfflineRecordActionsContext = createContext<WarcOfflineRecordActions>({});

/**
 * View a record through the store, and hand the blob url to the iframe viewer.
 *
 * Lives here rather than in the panel because the panel is rendered per row and
 * would otherwise each hold their own copy of the wiring.
 */
const useStoreViewAction = (): WarcOfflineRecordActions => {
    const context = useContext(WarcRecordContext);
    const supplied = useContext(WarcOfflineRecordActionsContext);

    /**
     * The live context, without the actions depending on it.
     *
     * This used to be called by every ROW, which meant every row subscribed to
     * the record context — and React.memo does not stop context propagation. So
     * during a parse, when the store hands out a new snapshot every animation
     * frame, every mounted row re-rendered every frame: exactly the fan-out that
     * createKeyedListeners, dirtyTreeUrls and the memo below exist to prevent.
     * The comments promising O(changed) were describing a property the code did
     * not have.
     *
     * Now it is called ONCE, at the tree root, and the result is published
     * through WarcOfflineRecordActionsContext with an identity that never
     * changes — so a row reading it is not woken by the snapshot at all.
     */
    const contextRef = useRef(context);

    useEffect(() => {
        contextRef.current = context;
    }, [context]);

    // Empty deps on purpose: the closure reads through the ref, so it never goes
    // stale and never needs rebuilding. A dep on `context` would restore the
    // per-frame churn this exists to remove.
    const storeActions = useMemo<WarcOfflineRecordActions>(() => ({
        onView: (record) => {
            const live = contextRef.current;
            if (!live?.viewArchivedRecord) return;

            // Synchronously, before anything is awaited. The tree can be
            // hundreds of rows below the frame, and a rebuild takes a worker
            // round trip per subresource — scrolling afterwards would move the
            // reader once the page they were waiting for had already arrived.
            focusArchiveViewer();

            void live.viewArchivedRecord(record, live.recordEntries).then(outcome => {
                if (outcome.ok) {
                    live.showBlob?.(outcome);
                    return;
                }

                // Fatal: nothing rendered, so it goes in place of the document
                // rather than into the corner badge.
                live.showViewFailure?.(outcome);
            });
        },

        /**
         * Save ONE capture, from the timeline row that names it.
         *
         * `idPolicy: 'always'`, unlike the viewer's ⤓ Save. That button saves the
         * page you are looking at, where readable paths matter and the record id
         * is only worth reaching for when two records collide. This button is
         * attached to a specific capture in a list of captures OF THE SAME URL —
         * distinguishing them is the entire reason the row exists — so every file
         * carries `<name>.<warc>.<uuid>.<ext>` from the start.
         *
         * That also makes the future queue free rather than a migration: names
         * derived from the record cannot move, so merging more captures into one
         * folder later never renames what is already there. Downloading them one
         * at a time today and merging tomorrow gives the same paths either way.
         */
        onDownload: (record) => {
            const live = contextRef.current;
            if (!live?.downloads) return;

            // The picker FIRST, synchronously. It needs transient user
            // activation, which the first await spends — see downloadButton.tsx.
            const pick = canSaveToFile()
                ? (window as WindowWithSavePicker).showSaveFilePicker?.({
                    suggestedName: suggestedFileName(record),
                    types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }],
                })
                : Promise.resolve(null);

            void Promise.resolve(pick)
                .then(handle => startDownload({
                    record,
                    entries: live.recordEntries,
                    downloads: live.downloads,
                    handle,
                    idPolicy: 'always',
                }))
                .catch(error => {
                    // Dismissing the dialog is not an error — the reader changed
                    // their mind, and a card saying so would be noise.
                    if (error instanceof DOMException && error.name === 'AbortError') return;

                    const failed = -Date.now();
                    live.downloads.start(failed, record.url, suggestedFileName(record));
                    live.downloads.fail(failed, {
                        reason: 'no-sink',
                        errorName: error instanceof Error ? error.name : 'Error',
                        message: error instanceof Error ? error.message : String(error),
                        url: record.url,
                    });
                });
        },
    }), []);

    // An explicitly provided action always wins: a caller that wired its own
    // viewer did so for a reason.
    if (supplied.onView || supplied.onDownload) return supplied;

    return storeActions;
};

/** Supply View/Download behaviour to every response panel below it. */
export function WarcOfflineRecordActionsProvider({
    actions,
    children,
}: {
    actions: WarcOfflineRecordActions;
    children: ReactNode;
}) {
    return (
        <WarcOfflineRecordActionsContext.Provider value={actions}>
            {children}
        </WarcOfflineRecordActionsContext.Provider>
    );
}

/**
 * The dot beside a node's capture count, coloured by the worst HTTP status under
 * it.
 *
 * Worst rather than newest: the dot exists so a reader can see, without opening
 * anything, that something under this url did not capture cleanly. A node whose
 * newest capture is a 200 but which also holds a 404 is exactly the case worth
 * flagging, and reporting the newest would hide it.
 *
 * Colour is never the only carrier — the button's aria-label states the count in
 * words, and `title` names the status.
 */
/**
 * The worst HTTP status under a node, as one number, in one allocation-free pass.
 *
 * Worst rather than newest: the dot exists so a reader can see, without opening
 * anything, that something under this url did not capture cleanly. A node whose
 * newest capture is a 200 but which also holds a 404 is exactly the case worth
 * flagging, and reporting the newest would hide it.
 *
 * One function for both the class and the title, because the first version was two
 * — and the title's version built three arrays and spread twice, per visible row,
 * on every row render. That runs up to sixty times a second during a parse, to
 * produce a tooltip nobody is hovering. `statusDotClass` beside it was already a
 * single loop; this is that loop, returning enough for both.
 *
 * Returns 0 for "no response records at all", which is a directory node.
 */
const worstStatusUnder = (node: WarcRecordTreeNode): number => {
    let worst = 0;
    let lowest = 0;

    for (const record of node.records) {
        if (record.type !== 'response') continue;

        const status = record.http?.status;

        // A response with no parsable status line is a capture whose outcome is
        // unknown — worse than a 2xx, better than having nothing at all.
        if (typeof status !== 'number') {
            if (worst === 0) worst = 1;
            continue;
        }

        if (status > worst) worst = status;
        if (lowest === 0 || status < lowest) lowest = status;
    }

    // A 2xx-only node reports its LOWEST, so the title can say "Captured (200)"
    // rather than naming a 204 that happens to sort higher. Encoded in the sign so
    // one pass still answers both questions.
    return worst >= 300 || worst <= 1 ? worst : lowest;
};

const statusDotClass = (worst: number): string => {
    if (worst >= 500) return s.dotSpecial;
    if (worst >= 400) return s.dotError;
    if (worst >= 300) return s.dotWarn;
    if (worst >= 200) return s.dot;

    return s.dotNone;
};

const statusDotTitle = (worst: number): string => {
    if (worst >= 500) return `Server error (${worst})`;
    if (worst >= 400) return `Not found or refused (${worst})`;
    if (worst >= 300) return `Redirect (${worst})`;
    if (worst >= 200) return `Captured (${worst})`;

    return 'No HTTP status recorded';
};

function WarcOfflineRecordListingItemImpl({
    node,
    depth,
}: {
    node: WarcRecordTreeNode;
    /** How deep in the tree, for the indent. Rows are siblings in the DOM now. */
    depth: number;
}) {
    const expansion = useContext(WarcTreeExpansionContext);
    const versions = useContext(WarcTreeVersionsContext);
    const timeline = useContext(WarcTreeTimelineContext);
    // NOT useStoreViewAction() — see the note there. Reading the record context
    // from a row is what made every row re-render on every store flush.
    const actions = useContext(WarcOfflineRecordActionsContext);

    // Subscribed for the side effect of re-rendering when this node changes.
    // Without it the memo below would make the row permanently stale, since its
    // props are a reference that never changes.
    //
    // The number is used, though: it is the only signal that node.children has
    // grown, since that array is mutated in place.
    const version = useNodeVersion(versions, node.url);

    // Collapsed is the safe default when this item renders outside a tree root.
    // Collapsed is the default; nothing seeds an open state.
    const open = useIsOpen(expansion, node.url, false);

    // Only nodes with children can be opened, and only a provider can record
    // that they were — no toggle otherwise, rather than one that does nothing.
    const canToggle = node.children.length > 0 && expansion !== undefined;

    // Responses only. A WARC stores a request alongside every response under the
    // same target url, so node.records.length counts each capture twice — a page
    // fetched once read "2 records". Recomputed on render rather than cached,
    // which is safe because the memo above means this row only renders when its
    // own version moved, and a node holds a handful of records.
    const responses = countResponseRecords(node.records);

    // One pass over the node's records, feeding both the dot's colour and its
    // tooltip. Only computed when there is a badge to put it on — a directory node
    // with no captures has no dot, and this is a loop over records on the hot path.
    const worstStatus = responses > 0 ? worstStatusUnder(node) : 0;

    const timelineOpen = useTimelineOpen(timeline, node.url);

    // Only when it is needed: encodeURIComponent on every row of a large tree,
    // for an id that is referenced only while the panel is open, is work that
    // never leaves the function.
    const panelId = timelineOpen ? `warc-responses-${encodeURIComponent(node.url)}` : undefined;

    return (
        // Positioned so the response panel can be absolutely placed against this
        // row. The panel deliberately covers whatever is below it rather than
        // pushing it down — which is also what keeps every row exactly
        // TREE_ROW_HEIGHT tall, and therefore what makes the window computable.
        <div className={s.rowWrap} style={indentFor(depth)}>
            {/*
              * The row fills only when its capture panel is open. That is the
              * whole of the visual hierarchy: every row used to be a solid
              * --accent-orange bar at 3.27:1, which fails AA and gave a
              * 1,800-row tree no shape at all.
              */}
            <div className={`${s.row}${timelineOpen ? ` ${s.rowOpen}` : ''}`}>
                {/*
                  * The chevron occupies its 14px whether or not this row has one,
                  * so names line up down the column. A leaf with no spacer sits
                  * 14px left of its siblings and the column stops reading as one.
                  */}
                {canToggle ? (
                    // A button, not a span: the toggle has to be reachable by
                    // keyboard, and aria-expanded is what announces its state.
                    <button
                        type="button"
                        onClick={() => expansion.toggle(node.url)}
                        aria-expanded={open}
                        aria-label={`${open ? 'Collapse' : 'Expand'} ${node.url}`}
                        className={s.toggle}
                    >
                        {open ? '▾' : '▸'}
                    </button>
                ) : (
                    <span aria-hidden className={s.toggleSpacer} />
                )}

                {/*
                  * min-width:0 via `.name`'s truncate is what lets a long url
                  * actually ellipsize: a flex item will not shrink below its
                  * content width without it, so it would push the trailing group
                  * off the row instead.
                  */}
                <span className={`${s.name} ${canToggle ? s.nameBranch : s.nameLeaf}`}>
                    {node.url}
                </span>

                <span className={s.trailing}>
                    {responses > 0 && (
                        // The badge is the panel's toggle, so it needs the panel's
                        // aria wiring — and NOT the aria-expanded/"Collapse" label
                        // it used to carry, which was copied from the tree toggle
                        // beside it and announced a second collapsible tree that
                        // never existed.
                        <button
                            type="button"
                            onClick={() => timeline?.toggle(node.url)}
                            disabled={timeline === undefined}
                            aria-expanded={timelineOpen}
                            aria-controls={timelineOpen ? panelId : undefined}
                            aria-label={`${timelineOpen ? 'Hide' : 'Show'} ${responses} archived ${responses === 1 ? 'response' : 'responses'} at ${node.url}`}
                            className={`${s.captures}${timelineOpen ? ` ${s.capturesOpen}` : ''}`}
                        >
                            {/*
                              * The dot carries status by colour, and `title`
                              * carries it for anyone who cannot use colour — the
                              * count beside it is never colour-only information.
                              */}
                            <span
                                aria-hidden
                                title={statusDotTitle(worstStatus)}
                                className={`${s.dot} ${statusDotClass(worstStatus)}`}
                            />
                            {responses}
                        </button>
                    )}
                </span>

            </div>

            {timelineOpen && timeline && (
                <div id={panelId}>
                    <WarcOfflineRecordListingTimeline
                        node={node}
                        onClose={timeline.close}
                        onView={actions.onView}
                        onDownload={actions.onDownload}
                    />
                </div>
            )}

        </div>
    );
}

/**
 * Memoised, and safe to memoise ONLY because of useNodeVersion above.
 *
 * `node` is mutated in place, so a shallow prop comparison always says "equal" —
 * on its own that would freeze every row at its first render. The subscription is
 * what re-renders a row, and the memo is what stops a parent's re-render from
 * cascading into thousands of untouched descendants. Removing either one breaks
 * the other: without memo the tree re-renders wholesale, without the
 * subscription it never re-renders at all.
 */
export const WarcOfflineRecordListingItem = memo(WarcOfflineRecordListingItemImpl);

/**
 * The rows themselves: flattened, windowed, and scrolled in their own pane.
 *
 * Separated from the tree root because it must sit INSIDE
 * WarcTreeExpansionProvider — it reads the expansion store to decide which rows
 * exist, and a component cannot consume a context it renders itself.
 */
function WarcOfflineTreeRows({ roots, versions, shapeKey, filter }: {
    roots: WarcRecordTreeNode[];
    versions: WarcTreeVersions;
    /** Which tree's shape signal to watch. See NORMAL_TREE_SHAPE_KEY. */
    shapeKey: string;
    /** A search, or undefined for the whole tree. */
    filter?: TreeFilter;
}) {
    const expansion = useContext(WarcTreeExpansionContext);
    const timeline = useContext(WarcTreeTimelineContext);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Where the reader is, and how much they can see. Both measured, because a
    // container that has not laid out yet reports zero and would render nothing.
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(0);

    /**
     * Any node created, anywhere.
     *
     * Per-node versions cannot answer "which rows exist": a node three levels
     * down appears without touching any url this list is watching. See
     * TREE_SHAPE_KEY. Each tree has its own key, so records landing in one do
     * not re-flatten the other — and only one is mounted at a time anyway.
     */
    const shape = useNodeVersion(versions, shapeKey);

    // Any toggle. Opening a node changes the rows, not just its own bracket.
    const openVersion = useSyncExternalStore(
        expansion?.subscribeAny ?? neverSubscribe,
        () => expansion?.version() ?? 0,
        () => 0,
    );

    /**
     * Whether a capture panel is open anywhere in the tree.
     *
     * Only used to raise the pane's floor so the panel has somewhere to be — see
     * .scrollPaneWithPanel. Fires on the first open and the last close only, not
     * on every row-to-row toggle.
     */
    const panelOpen = useSyncExternalStore(
        timeline?.subscribeAny ?? neverSubscribe,
        () => timeline?.hasOpen() ?? false,
        () => false,
    );

    /**
     * Every row a reader can currently see.
     *
     * Recomputed when the tree gains a node or a node is toggled, and not
     * otherwise — so during a parse this is one walk per animation frame rather
     * than one per record. The walk is O(visible rows), which is 14 with
     * everything collapsed and 13,630 with everything open; the RENDER stays
     * bounded either way, which is the point.
     */
    const rows = useMemo(
        () => flattenVisibleTree(
            roots,
            // While searching, everything on the path to a match counts as open.
            // The alternative is a reader who types a query, gets three collapsed
            // roots, and has to click down to find what they already asked for.
            // Their own expansion state is untouched and comes back on clear.
            (url) => (filter ? filter.keep.has(url) : false) || (expansion?.isOpen(url) ?? false),
            filter,
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [roots, expansion, shape, openVersion, filter],
    );

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;

        const measure = () => setHeight(element.clientHeight);
        measure();

        // Resizes, not just the first paint: a window resize or a panel opening
        // beside it changes how many rows fit.
        if (typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const { start, end } = windowRange(rows.length, scrollTop, height);
    const visible = rows.slice(start, end);

    return (
        <div
            ref={scrollRef}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            className={panelOpen ? shared.scrollPaneWithPanel : shared.scrollPane}
            /*
             * The row height, stated ONCE, from the constant the windowing maths
             * uses. `.rowWrap` is `height: var(--warc-row-height)` and `.rowBox`
             * is that minus 4, so a rendered row cannot disagree with the spacers
             * below.
             *
             * It used to disagree. ROW_BOX was `TREE_ROW_HEIGHT - 4` = 32 and
             * nothing gave the wrapper the missing 4px, so every rendered row was
             * 32px inside a window that reserved 36 — the pane's scrollHeight came
             * out as `len*36 - visible*4` and shrank as you scrolled, sliding the
             * rows out from under the scrollbar. Setting it here on the container
             * rather than per row means one inline style for the whole tree
             * instead of one per row, and no way for the two numbers to drift.
             */
            style={{ '--warc-row-height': `${TREE_ROW_HEIGHT}px` } as CSSProperties}
            // A tree of 13,630 urls is a scrollable pane rather than 13,630 rows
            // of page. Nothing is hidden — this is still the complete record
            // listing — the rows outside the window are simply not mounted.
            role="tree"
            aria-label="Archived urls"
        >
            {/*
              * Spacers rather than absolute positioning: they give the scrollbar
              * the right length and put the rendered slice at the right offset,
              * with no per-row `top` to get wrong.
              */}
            <div style={{ height: start * TREE_ROW_HEIGHT }} />

            {visible.map((row: FlatTreeRow) => (
                <div key={row.node.url} role="treeitem" aria-level={row.depth + 1}>
                    <WarcOfflineRecordListingItem node={row.node} depth={row.depth} />
                </div>
            ))}

            <div style={{ height: Math.max(0, rows.length - end) * TREE_ROW_HEIGHT }} />

            {rows.length === 0 && (
                <p className={s.empty}>
                    No records yet. Select .warc, .warc.gz or .wacz files below and process them.
                </p>
            )}
        </div>
    );
}

export default function WarcOfflineRecordListingTree() {
    const context = useContext(WarcRecordContext);

    // Called here, once, rather than in each row. Hooks cannot be called after
    // the early return below, so this sits above it.
    const actions = useStoreViewAction();

    // Created once, for the same reason as the expansion store: a store whose
    // identity changed would wake every mounted row on every open.
    const [timeline] = useState(createWarcTreeTimeline);

    /**
     * Which tree is on screen.
     *
     * Both are built and both stay built — this only picks one to render. Making
     * it a rebuild instead would mean re-walking every record on each toggle, and
     * the point of maintaining two is that switching is free.
     */
    const [normalized, setNormalized] = useState(false);
    const [query, setQuery] = useState('');

    // '' means every type, which is why the filter treats it as "not active"
    // rather than as a type nothing matches.
    const [contentType, setContentType] = useState('');

    const entries = context?.recordEntries;

    /**
     * Which nodes a search leaves visible.
     *
     * Recomputed when the query, the tree, or the tree's SHAPE changes — that
     * last one matters during a parse, where nodes keep arriving and a filter
     * computed once would freeze the results at whatever had been read when the
     * reader stopped typing.
     */
    const shape = useNodeVersion(
        context?.treeVersions,
        normalized ? NORMAL_TREE_SHAPE_KEY : TREE_SHAPE_KEY);

    const filter = useMemo(() => {
        if (!entries) return undefined;

        const searching = query.trim() !== '';
        if (!searching && contentType === '') return undefined;

        const segments = normalized ? entries.normalSegments : entries.segments;
        const types = normalized ? entries.normalContentTypes : entries.contentTypes;
        const index = normalized ? entries.normalTreeIndex : entries.recordTreeIndex;

        // null means "this filter is not active", which is what lets the two be
        // combined without the caller knowing which of them the reader used.
        const byText = searching ? findTreeSegments(query, segments) : null;
        const byType = contentType === '' ? null : findTreeContentType(contentType, types);

        return treeFilterFor(intersectMatches(byText, byType) ?? [], index);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, contentType, normalized, entries, shape]);

    /**
     * What the archive actually contains, alphabetically.
     *
     * Built from the index rather than from a hardcoded list of MIME types, so a
     * WARC full of `application/x-shockwave-flash` says so and a reader is never
     * offered a type with nothing behind it.
     */
    /*
     * Keyed on the number of DISTINCT TYPES, not on `shape`.
     *
     * `shape` bumps for every node created anywhere, so this rebuilt — entries
     * spread, mapped, and collator-sorted — on every animation frame for the whole
     * parse, to produce a list that changes perhaps twenty times in total.
     *
     * The size is a sound signal because a type is only ever ADDED to this map:
     * ensureTreeNode files a node under its record's type and nothing removes one,
     * so the set cannot change without the count changing. Read during render,
     * which is fine — it is a plain property on a Map the store mutates in place,
     * and the component is already re-rendering when it is read.
     */
    const typeMap = entries
        ? (normalized ? entries.normalContentTypes : entries.contentTypes)
        : undefined;

    const availableTypes = useMemo(
        () => (typeMap ? listContentTypes(typeMap) : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [typeMap, typeMap?.size]);

    /*
     * The <option> elements, memoised alongside.
     *
     * `availableTypes` being referentially stable is not enough on its own: the
     * `.map()` in the JSX would still run per render and hand React a fresh array
     * of fresh elements to reconcile against the old ones. One <option> per content
     * type, sixty times a second, for a dropdown nobody has opened.
     */
    const typeOptions = useMemo(
        () => availableTypes.map(({ type, nodes }) => (
            <option key={type} value={type}>{`${type} (${nodes})`}</option>
        )),
        [availableTypes]);

    // Undefined only when this renders outside OfflineContextProvider, which is
    // a mounting mistake rather than an empty-tree state.
    if (!context) {
        return null;
    }

    const roots = normalized ? context.normalTree : context.recordTree;
    const shapeKey = normalized ? NORMAL_TREE_SHAPE_KEY : TREE_SHAPE_KEY;

    return (
        <WarcOfflineRecordActionsProvider actions={actions}>
        <WarcTreeVersionsContext.Provider value={context.treeVersions}>
            <WarcTreeTimelineContext.Provider value={timeline}>
                <WarcTreeExpansionProvider>
                    <div className={s.toolbar}>
                        {/*
                          * Matches SEGMENTS, not whole urls, because that is what
                          * the index holds — see WarcRecordEntries.segments. A
                          * query with a slash in it therefore finds nothing, which
                          * the placeholder says rather than leaving the reader to
                          * infer it from an empty tree.
                          */}
                        <input
                            type="search"
                            value={query}
                            onChange={event => setQuery(event.target.value)}
                            placeholder="Search url segments…"
                            aria-label="Search url segments"
                            className={shared.searchField}
                        />

                        <label className={shared.checkboxLabel}>
                            <input
                                type="checkbox"
                                checked={normalized}
                                onChange={event => setNormalized(event.target.checked)}
                                className={shared.checkbox}
                            />
                            Normalized URLs
                        </label>

                        {/*
                          * Every type in the archive, with how many nodes hold one.
                          * The count is what makes the list worth reading: it turns
                          * "what is in here?" into an answer before anything is
                          * even selected.
                          */}
                        <select
                            value={contentType}
                            onChange={event => setContentType(event.target.value)}
                            aria-label="Filter by content type"
                            className={shared.typeSelect}
                        >
                            <option value="">All content types</option>
                            {typeOptions}
                        </select>

                        {/*
                          * What each control actually did, where a reader wonders.
                          * "Normalized" alone does not say WHICH normalisation, and
                          * a filtered tree with no count leaves "is that all of
                          * them?" unanswerable.
                          */}
                        <span className={s.hint}>
                            {filter
                                ? `${filter.matched.size} match${filter.matched.size === 1 ? '' : 'es'}`
                                : normalized
                                    ? 'grouped by host — scheme, www. and port dropped'
                                    : 'grouped by origin, as captured'}
                        </span>
                    </div>

                    {/*
                      * Keyed on which tree it is. The two have different roots and
                      * different urls, so reusing the mounted rows would ask React
                      * to reconcile every one of them against an unrelated node —
                      * and the scroll offset, measured in rows, would point
                      * somewhere arbitrary in a list of a different length.
                      */}
                    <WarcOfflineTreeRows
                        key={shapeKey}
                        roots={roots}
                        versions={context.treeVersions}
                        shapeKey={shapeKey}
                        filter={filter}
                    />
                </WarcTreeExpansionProvider>
            </WarcTreeTimelineContext.Provider>
        </WarcTreeVersionsContext.Provider>
        </WarcOfflineRecordActionsProvider>
    );
}
