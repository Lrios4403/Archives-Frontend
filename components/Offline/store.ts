'use client';

import { createRecordEntries, pushFileHandle, pushRecord, setFileHandles } from "./records";
import {
    WarcFileHande,
    WarcFilesState,
    WarcRecord,
    WarcRecordContextType,
    WarcRecordEntries,
    WarcRecordTreeNode,
    WarcTreeVersions,
    WarcViewState,
} from "./types";
import {
    goBackThroughBrowser,
    goForwardThroughBrowser,
    pushViewEntry,
    subscribeToViewHistory,
    unwindViewEntries,
    type ViewHistoryPosition,
} from "./browserHistory";
import { createWarcDownloadStore } from "./downloads";
import { createWarcNoticeStore } from "./notices";
import { viewArchivedRecord, type MissingRef, type ViewOutcome } from "./view";
import { parseFileHandles } from "./workers";

/**
 * The listener half of a useSyncExternalStore store.
 *
 * Everything in the offline viewer is mutated in place — records pushed by
 * parser workers, urls added to the tree's expansion set — because copying a
 * list of tens of thousands of records on every change would cost more than the
 * parse that produced them. Mutation is not the bug; the missing half is
 * telling React it happened, and that is all this provides.
 */
export const createListeners = () => {
    const listeners = new Set<() => void>();

    return {
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },

        emit: () => {
            listeners.forEach(listener => listener());
        },
    };
};

/** A subscribe that never fires, for hooks reading a store that is not there. */
export const neverSubscribe = () => () => {};

/**
 * Listeners keyed by url, so a change wakes only what it changed.
 *
 * The tree used to share one listener Set across every mounted row: each rAF
 * flush walked all of them and each re-read its own version out of a Map. That
 * is O(mounted rows) per frame to re-render two — expand a large host during a
 * parse and it is hundreds of thousands of calls a second, doing nothing. Keyed,
 * a flush costs O(nodes that actually changed).
 *
 * `subscribeTo` MEMOISES per key, because useSyncExternalStore resubscribes
 * whenever the subscribe function's identity changes — handing it a fresh
 * closure each render would tear down and rebuild every row's subscription on
 * every render, which is worse than the problem being fixed.
 */
export const createKeyedListeners = () => {
    const byKey = new Map<string, Set<() => void>>();
    const subscribers = new Map<string, (listener: () => void) => () => void>();

    return {
        subscribeTo: (key: string) => {
            const cached = subscribers.get(key);
            if (cached) return cached;

            const subscribe = (listener: () => void) => {
                let listeners = byKey.get(key);

                if (!listeners) {
                    listeners = new Set();
                    byKey.set(key, listeners);
                }

                listeners.add(listener);

                return () => {
                    listeners!.delete(listener);

                    // Drop the key entirely once nothing is listening. A tree can
                    // hold a hundred thousand nodes and only a screenful is ever
                    // mounted, so keeping a Set and a closure per url ever seen
                    // would be a leak that grows with the archive.
                    if (listeners!.size === 0) {
                        byKey.delete(key);
                        subscribers.delete(key);
                    }
                };
            };

            subscribers.set(key, subscribe);

            return subscribe;
        },

        emit: (key: string) => {
            byKey.get(key)?.forEach(listener => listener());
        },

        emitEach: (keys: Iterable<string>) => {
            for (const key of keys) {
                byKey.get(key)?.forEach(listener => listener());
            }
        },
    };
};

export interface WarcRecordStore {
    subscribe: (listener: () => void) => () => void;

    /** The stable half. Its identity never changes, so this never forces a render. */
    getSnapshot: () => WarcRecordContextType;

    /** What the frame is showing. New identity only when a view changes. */
    getViewSnapshot: () => WarcViewState;

    /** The selected files. New identity only when the selection changes. */
    getFilesSnapshot: () => WarcFilesState;
    /** Revoke the current view's blob urls and drop the trail. See the provider. */
    dispose: () => void;

    /**
     * Subscribe to browser Back/Forward. Returns the stop function.
     *
     * Called from an effect, not at construction, so that StrictMode's
     * mount/unmount/remount re-establishes it — see the note on onHistoryMove.
     */
    startHistory: () => () => void;
}

/**
 * The mutable state behind WarcRecordContext, one store per provider mount.
 *
 * Each action runs the plain mutation from records.ts and then marks the store
 * dirty. Notification is coalesced to one flush per frame: a parse pushes a
 * record per WARC record, far faster than anything can usefully be drawn, and
 * every listener re-reads the whole snapshot anyway — so a burst of pushes
 * costs one render rather than tens of thousands.
 */
export const createWarcRecordStore = (): WarcRecordStore => {
    const fileHandles: WarcFileHande[] = [];

    /*
     * The fixtures in examples.ts are no longer imported.
     *
     * USE_EXAMPLE_DATA has been false for a long time, but the import was
     * unconditional, so 357 lines of sample records shipped to every reader in
     * the hope a bundler would prove the branch dead. It could not: the file is
     * still there and still runnable, it is simply not wired in. To use it
     * again, import createExampleRecordEntries here — the seam is one line.
     */
    const recordEntries: WarcRecordEntries = createRecordEntries();

    // The same array pushRecord writes into, aliased on purpose — a copy would
    // freeze the tree at mount and never show a record that arrived after.
    //
    // This no longer starts from exampleRecordTree. createExampleRecordEntries
    // runs the fixture records through pushRecord, so the tree is built by the
    // same code path production uses, and each mount gets its own nodes.
    // exampleRecordTree goes back to being what its comment says: the expected
    // output to check that builder against, not the live data.
    const recordTree: WarcRecordTreeNode[] = recordEntries.recordTree;

    // Aliased for the same reason, and separately: the two are different arrays
    // and a consumer picks one. See WarcRecordEntries.normalTree.
    const normalTree: WarcRecordTreeNode[] = recordEntries.normalTree;

    /**
     * Bumped when the SELECTION changes — a file added, or the set replaced.
     *
     * fileHandles is mutated in place, so its identity is not a signal: two
     * snapshots always hand out the same array. Anything wanting to know whether
     * the list of files changed has to be told, and this is how. Deliberately
     * NOT bumped by parse progress, which moves fields on the handles rather
     * than changing which files there are.
     */
    let fileHandlesRevision = 0;

    // Cached slice snapshots, and whether each needs rebuilding on the next
    // flush. Two booleans rather than one, so a navigation does not invalidate
    // the file list and a file selection does not invalidate the view.
    let viewSnapshot: WarcViewState | null = null;
    let filesSnapshot: WarcFilesState | null = null;
    let viewDirty = false;
    let filesDirty = false;

    /** The view changed: rebuild that slice on the next flush and wake readers. */
    const notifyView = () => { viewDirty = true; notify(); };

    /** The file SELECTION changed. Not called by parse progress — see the note above. */
    const notifyFiles = () => { filesDirty = true; notify(); };

    // What the iframe is showing. `recordBlobUrl` has been on the context since
    // the viewer was scaffolded and always null; this is what it was for.
    let recordBlobUrl: string | null = null;
    let recordBlobType: string | null = null;
    let viewFailure: Extract<ViewOutcome, { ok: false }> | null = null;
    // Where the document on screen redirects, when it is a bodied 3xx being
    // shown rather than followed. Travels with the view so the frame's
    // "Redirects to" bar appears however the reader got here.
    let viewingRedirectsTo: string | null = null;

    // Revokes the blob urls of whatever is currently showing. Held rather than
    // derived because the urls belong to the view that created them, and once a
    // new view replaces it there is nothing left to ask.
    let revokeCurrentView: (() => void) | null = null;

    /**
     * Where the reader has been, and where in that trail they are.
     *
     * RECORDS, not blob urls. Holding the built pages would pin every asset of
     * every page ever visited — twenty pages back is twenty pages of images still
     * in memory — so a history entry is the identity of a capture and Back
     * rebuilds it. A record is a byte range and some headers; the archive it
     * points into is already open.
     */
    let viewHistory: WarcRecord[] = [];
    let viewIndex = -1;

    /**
     * Bumped by every navigation, so a rebuild that finishes late can tell.
     *
     * Back and Forward rebuild asynchronously. Press Back twice quickly and two
     * rebuilds are in flight; without this the slower one wins and the reader
     * lands somewhere they did not ask for. Whoever is not the most recent
     * discards its result — and revokes it, or those blobs leak.
     */
    let viewEpoch = 0;

    /** Cap on the trail. Deep enough to be a history, bounded so it is not a leak. */
    const MAX_HISTORY = 50;

    const releaseView = () => {
        revokeCurrentView?.();
        revokeCurrentView = null;
        recordBlobUrl = null;
        recordBlobType = null;
        viewFailure = null;
        viewingRedirectsTo = null;
    };

    // Built once per store, like the other sub-stores: its identity is on every
    // snapshot, so a new one per flush would re-render every consumer.
    const notices = createWarcNoticeStore();

    // Same, and for the same reason. Deliberately NOT cleared by clearView or
    // dispose: a download survives the view it came from, and the whole point of
    // keeping finished sessions is that a failure is still readable afterwards.
    const downloads = createWarcDownloadStore();

    /**
     * Put a rebuilt document on screen and file what it could not find.
     *
     * Split out of showBlob so that moving through history and opening something
     * new share ONE display path. The difference between them is what happens to
     * the history stack, and that is the only difference — which is why the rest
     * lives here rather than being written twice with a flag to tell them apart.
     */
    const displayView = (outcome: Extract<ViewOutcome, { ok: true }>) => {
        // The previous view's urls go now, not on unmount: each one pins its
        // Blob, and a reader clicking through twenty pages would otherwise
        // hold every asset from all twenty.
        releaseView();
        recordBlobUrl = outcome.url;
        recordBlobType = outcome.type;
        revokeCurrentView = outcome.revoke;
        viewingRedirectsTo = outcome.redirectsTo;

        /*
         * The outgoing document's notices go with it.
         *
         * These used to accumulate across every page of a session, on the theory
         * that the cumulative set of gaps in an archive is the interesting one.
         * In practice it read as a bug: the badge is anchored to the corner of
         * the FRAME and says "N resources could not be loaded", so a reader who
         * dismissed it on one page met it again on the next, reporting things
         * that had nothing to do with what they were now looking at — and it had
         * to be dismissed once per page, forever.
         *
         * The badge's position was the honest signal. It describes the document
         * on screen, so its contents are scoped to the document on screen. Note
         * this clears BEFORE the add below, and only on a view transition —
         * reportMissing keeps appending to the live document as the iframe's shim
         * discovers more.
         */
        notices.clear();

        // documentUrl, not the url asked for: after a redirect those differ,
        // and the table should name the page that actually rendered.
        if (outcome.missing.length > 0) notices.add(outcome.documentUrl, outcome.missing);
    };

    /**
     * Go to an absolute position in the trail and rebuild what is there.
     *
     * The index moves SYNCHRONOUSLY, before the rebuild is awaited, so pressing
     * Back three times quickly goes back three — each press reads the position
     * the one before it left. Only the display waits.
     */
    const goTo = async (target: number): Promise<void> => {
        const record = viewHistory[target];

        if (!record) return;

        viewIndex = target;
        notifyView();

        const mine = ++viewEpoch;
        const outcome = await viewArchivedRecord(record, recordEntries);

        // Someone navigated while this was rebuilding. Its blobs are already
        // minted and nothing will ever show them, so they have to go here.
        if (mine !== viewEpoch) {
            if (outcome.ok) outcome.revoke();
            return;
        }

        if (outcome.ok) displayView(outcome);
        else {
            releaseView();
            viewFailure = outcome;
        }

        notifyView();
    };

    /**
     * Where a browser history entry points, now.
     *
     * By id first. The trail is capped at MAX_HISTORY, so once a reader passes
     * that cap the oldest entry is dropped and every index below it shifts by
     * one — an entry written before the shift would then rebuild its neighbour.
     * The id survives that; the index is the fallback for entries that predate
     * it, clamped so a stale one lands at an end of the trail rather than
     * nowhere.
     */
    const resolveHistoryPosition = (position: ViewHistoryPosition): number => {
        if (position.id !== null) {
            const found = viewHistory.findIndex(record => record.customId === position.id);
            if (found >= 0) return found;
        }

        return Math.max(0, Math.min(position.index, viewHistory.length - 1));
    };

    /**
     * The reader pressed the browser's Back or Forward.
     *
     * The HANDLER lives here because the trail lives here. The SUBSCRIPTION is
     * started by the provider in an effect and torn down in that effect's cleanup,
     * which is the one shape React can be trusted with.
     *
     * It used to subscribe eagerly at store construction and unsubscribe inside
     * `dispose`, which was quietly broken in development: StrictMode mounts,
     * unmounts and remounts every effect, so the cleanup ran once, `dispose` called
     * the stop function, and nothing existed to re-subscribe — Back and Forward
     * were dead for the rest of the session, in dev only, on a store that looked
     * perfectly healthy. An effect that undoes exactly what it did is the fix.
     */
    const onHistoryMove = (position: ViewHistoryPosition | null) => {
        // Backed out past the first archived page. Nothing to rebuild: the entry
        // they landed on is the one from before the viewer was opened, so the
        // honest response is to show what was there then.
        if (position === null) {
            /*
             * Unless a fatal error is on screen, which this must not erase.
             *
             * showViewFailure unwinds the session's history entries, and that unwind
             * produces a popstate landing outside the session — indistinguishable
             * from the reader backing out. Answering it by releasing the view wiped
             * the error one line after it was set, so navigating to an unarchived
             * page closed the viewer and showed the empty state instead of saying
             * why.
             *
             * browserHistory now suppresses its own popstate reliably (it used to
             * expire the suppression on a zero-delay timer, before the event it was
             * for could arrive), so this should be unreachable. Kept because the
             * failure mode is silent and the invariant is worth stating outright:
             * a history event means "where am I", never "forget what went wrong".
             */
            if (viewFailure) return;

            viewEpoch++;
            releaseView();
            viewHistory = [];
            viewIndex = -1;
            notifyView();
            return;
        }

        void goTo(resolveHistoryPosition(position));
    };

    const { subscribe, emit } = createListeners();

    // Rows subscribe here, one key per node url, rather than to `subscribe`.
    const nodeListeners = createKeyedListeners();

    /**
     * Per-node change signal for the tree rows.
     *
     * Shares the store's one-flush-per-frame coalescing — a burst of pushes still
     * costs one notification — but notifies per NODE rather than globally. It used
     * to reuse `subscribe`, which meant a flush woke every mounted row so each
     * could re-read its own number and discover it had not changed. Correct, and
     * O(mounted rows) per frame to re-render two of them.
     *
     * Built once: its identity must never change, or every row resubscribes on
     * every render.
     */
    const treeVersions: WarcTreeVersions = {
        subscribeTo: nodeListeners.subscribeTo,
        versionOf: (url: string) => recordEntries.treeVersions.get(url) ?? 0,
    };

    let flushScheduled = false;

    const flush = () => {
        flushScheduled = false;

        /*
         * Only the slices that actually moved.
         *
         * This used to drop one whole-world snapshot and emit unconditionally,
         * which woke every context consumer once per animation frame for the
         * duration of a parse — while the thing that had changed was almost
         * always just some tree nodes. Records now signal ONLY through
         * dirtyTreeUrls below; the view and file slices say so for themselves.
         */
        if (viewDirty || filesDirty) {
            if (viewDirty) viewSnapshot = null;
            if (filesDirty) filesSnapshot = null;
            viewDirty = false;
            filesDirty = false;
            emit();
        }

        // Then the rows, one wake per node that actually moved. Drained rather
        // than iterated in place: a listener can push another record — the store
        // is mutable and shared — and that belongs to the next frame, not this one.
        if (recordEntries.dirtyTreeUrls.size > 0) {
            const dirty = Array.from(recordEntries.dirtyTreeUrls);
            recordEntries.dirtyTreeUrls.clear();
            nodeListeners.emitEach(dirty);
        }
    };

    const notify = () => {
        if (flushScheduled) {
            return;
        }

        flushScheduled = true;

        // setTimeout only covers the no-rAF case (SSR), where nothing calls
        // notify to begin with.
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(flush);
        } else {
            setTimeout(flush, 0);
        }
    };

    // Built once so their identities stay stable across snapshots, leaving the
    // snapshot's data fields as the only thing a consumer sees change.
    const actions = {

        // Records signal ONLY through dirtyTreeUrls, drained by the flush. No
        // slice changes, so no context consumer is woken — during a parse this
        // is the difference between waking every consumer sixty times a second
        // and waking the handful of tree rows whose own node moved.
        pushRecord: (record: WarcRecord, recordsRef: WarcRecordEntries) => {
            // A record already held changes nothing, so it wakes nothing.
            if (pushRecord(record, recordsRef)) notify();
        },

        pushFileHandle: (handle: WarcFileHande, handlesRef: WarcFileHande[]) => {
            pushFileHandle(handle, handlesRef);
            fileHandlesRevision++;
            notifyFiles();
        },

        setFileHandles: (handles: WarcFileHande[], handlesRef: WarcFileHande[]) => {
            setFileHandles(handles, handlesRef);
            fileHandlesRevision++;
            notifyFiles();
        },

        // The workers call records.ts' own pushRecord, not the wrapper above, so
        // notify has to be handed down to them — otherwise the records that
        // arrive from a parse are exactly the ones React never hears about.
        parseFileHandles: (workers: number, handles: WarcFileHande[], recordsRef: WarcRecordEntries) =>
            parseFileHandles(workers, handles, recordsRef, notify),

        /**
         * Show a rebuilt document, and record what it could not find.
         *
         * Takes the whole outcome rather than three fields out of it because the
         * notices are collected HERE — the one funnel every successful view goes
         * through — instead of by each caller.
         *
         * That was the bug this replaces. Collection used to sit in the
         * viewArchivedRecord wrapper below, which the tree's View button goes
         * through and the iframe's link handler does not: clicking a link called
         * navigateArchived directly, so a page missing forty assets reported
         * nothing at all. Two callers, one of them remembering. Anything that can
         * be forgotten by a caller eventually is, so the caller no longer has the
         * option.
         */
        showBlob: (outcome: Extract<ViewOutcome, { ok: true }>) => {
            viewEpoch++;
            displayView(outcome);

            // Anything ahead of here is a future the reader just abandoned by
            // going somewhere else — same rule a browser follows.
            viewHistory = [...viewHistory.slice(0, viewIndex + 1), outcome.record];

            if (viewHistory.length > MAX_HISTORY) viewHistory = viewHistory.slice(-MAX_HISTORY);

            viewIndex = viewHistory.length - 1;

            // One browser entry per archived page, so the tab's Back button and
            // the arrow in the frame header are the same action rather than two
            // histories drifting apart.
            pushViewEntry(viewIndex, outcome.record.customId);

            notifyView();
        },

        /*
         * The arrows move the BROWSER, and the browser moves the store.
         *
         * Stepping the store directly would work exactly once: the tab's cursor
         * would stay where it was, and from then on its Back button would land on
         * an entry describing a position the reader had already left. One cursor,
         * one source of truth — the store steps only in response to popstate.
         *
         * The direct step is the fallback for a browser with no pushState, and for
         * the server render where there is no window at all.
         */
        goBack: () => { if (!goBackThroughBrowser()) void goTo(viewIndex - 1); },
        goForward: () => { if (!goForwardThroughBrowser()) void goTo(viewIndex + 1); },

        /**
         * Jump straight to a position in the trail, for the history dropdown.
         *
         * Not routed through the browser: there is no "go to the Nth entry" in the
         * History API, only relative movement, and computing the offset would
         * depend on the browser cursor being exactly where the store thinks it is.
         * The entry is rewritten afterwards instead, so a Back press from here
         * still lands one page earlier in the trail rather than replaying the jump.
         */
        goToView: (index: number) => {
            if (index === viewIndex || !viewHistory[index]) return;

            void goTo(index).then(() => {
                pushViewEntry(index, viewHistory[index]?.customId ?? null);
            });
        },

        showViewFailure: (failure: Extract<ViewOutcome, { ok: false }>) => {
            viewEpoch++;
            releaseView();
            viewFailure = failure;

            // The trail has to move with the frame. `viewingRecord` is derived
            // from recordBlobUrl, which releaseView just cleared, so leaving the
            // index where it was left canGoBack true against a position nothing
            // is showing — and goTo() would then rebuild from a page the reader
            // never got to.
            viewHistory = [];
            viewIndex = -1;

            // Same reasoning for the browser's entries: they point into the trail
            // that was just dropped.
            unwindViewEntries();

            notifyView();
        },

        clearView: () => {
            viewEpoch++;
            releaseView();

            // And the notices, for the same reason displayView clears them: they
            // describe a document that is no longer on screen. Leaving them would
            // put a badge over an empty frame, about a page the reader closed.
            notices.clear();

            // The trail belongs to the browsing session being closed. Keeping it
            // would leave Back pointing into a frame that is no longer showing
            // anything, which reads as a bug rather than as a feature.
            viewHistory = [];
            viewIndex = -1;

            // And so do the browser entries. Left in place they would be a run of
            // Back presses that each do nothing visible, because the trail they
            // point into is the one just discarded.
            unwindViewEntries();

            notifyView();
        },

        /**
         * File non-fatal problems the STORE did not observe for itself.
         *
         * The fetch/XHR shim runs in the iframe and its misses arrive over
         * postMessage, long after the view that is showing was built — so they
         * cannot ride along on an outcome. This is the seam for them, and it
         * keeps notices.add in one file, which is the property that made the
         * link-click bug findable.
         */
        reportMissing: (viewing: string, refs: readonly MissingRef[]) => {
            notices.add(viewing, refs);
        },

        // A plain pass-through now. Notices are added by showBlob, so a caller
        // that resolves a view without showing it reports nothing — which is
        // right: nothing was missing from a page nobody looked at.
        viewArchivedRecord,
    };

    /**
     * The stable half: built once, handed out unchanged forever.
     *
     * Nothing in here can change identity — recordEntries, recordTree and
     * treeVersions are mutated in place, notices is a store, and the actions are
     * bound once. So a component reading this context is never re-rendered by
     * the store at all, which is the entire reason the context was split.
     */
    let snapshot: WarcRecordContextType | null = null;

    const getSnapshot = (): WarcRecordContextType => {
        if (!snapshot) {
            snapshot = { recordEntries, recordTree, normalTree, treeVersions, notices, downloads, ...actions };
        }

        return snapshot;
    };

    /** What the frame is showing. Rebuilt only when a view changes. */
    const getViewSnapshot = (): WarcViewState => {
        if (!viewSnapshot) {
            viewSnapshot = {
                recordBlobUrl,
                recordBlobType,
                viewFailure,
                // The capture on screen, for the header and the timeline. Null
                // whenever nothing is showing, including after a fatal error.
                viewingRecord: recordBlobUrl ? viewHistory[viewIndex] ?? null : null,
                viewingRedirectsTo: recordBlobUrl ? viewingRedirectsTo : null,
                canGoBack: viewIndex > 0,
                canGoForward: viewIndex >= 0 && viewIndex < viewHistory.length - 1,
                // The store's own array. Safe to share only because every
                // mutation above REPLACES it rather than splicing it, so a
                // snapshot handed out earlier still describes the trail as it was
                // when that snapshot was made.
                viewTrail: viewHistory,
                viewIndex,
            };
        }

        return viewSnapshot;
    };

    /** The selected files. Rebuilt only when the selection changes. */
    const getFilesSnapshot = (): WarcFilesState => {
        if (!filesSnapshot) {
            filesSnapshot = { fileHandles, revision: fileHandlesRevision };
        }

        return filesSnapshot;
    };

    return {
        subscribe,
        getSnapshot,
        getViewSnapshot,
        getFilesSnapshot,

        /**
         * Release everything this store is holding open.
         *
         * Called when the provider unmounts. Without it, navigating away from
         * the offline page with a document showing left the whole view behind:
         * the document's blob plus every subresource blob it pinned, which for
         * an image-heavy page is the entire page still resident with nothing
         * able to reach it. `revokeCurrentView` is the only handle on them, and
         * it lives in this closure.
         */
        dispose: () => {
            releaseView();
            viewHistory = [];
            viewIndex = -1;
        },

        /**
         * Start listening for Back and Forward. Returns the stop function.
         *
         * Shaped for an effect — subscribe on mount, stop on cleanup, subscribe
         * again on the next mount — because that is what makes it survive
         * StrictMode's deliberate double-mount. The listener closes over this
         * store, so leaving it attached after a real unmount would keep the store
         * alive and let a Back press on some later page try to rebuild a view here;
         * the cleanup is what prevents that, and it is now the caller's to run.
         */
        startHistory: () => subscribeToViewHistory(onHistoryMove),
    };
};
