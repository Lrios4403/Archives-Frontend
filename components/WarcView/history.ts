'use client';

import { createListeners } from "@/components/Offline/store";

/**
 * The /warcs/view trail: every capture visited, in the order it was reached.
 *
 * ## Why a store rather than the module binding this replaces
 *
 * The first version kept the trail in a plain module-scope array, which worked
 * and was wrong twice over: nothing else on the page could subscribe to it, so
 * the capture list could never mark the rows a reader had been to, and one
 * shared binding per process meant every test leaked into the next.
 *
 * ## Why the trail is NOT persisted
 *
 * It was, to sessionStorage, so a stray F5 would not lose it. That turned out to
 * be the wrong trade. sessionStorage lives as long as the TAB, and the trail is
 * a reading session — so going home, or to /warcs/offline, or to a search and
 * then opening a completely unrelated archive, arrived with the previous site's
 * pages still in Back and still in the address dropdown.
 *
 * The obvious patch was to keep the store only across a reload, told apart by
 * the Navigation Timing type. That is not enough: after a reload the type stays
 * "reload" for the life of that document, so soft-navigating out of the viewer
 * and back in still restored the stale trail. Distinguishing the two properly
 * needs a flag saying the viewer was left, which is exactly the sort of state
 * StrictMode's mount/unmount/remount gets wrong.
 *
 * So the trail lives in the store and nowhere else. It is created when the
 * provider mounts and dies when the reader leaves /warcs/view, which is the
 * boundary a reading session actually has. The cost is that a reload starts a
 * fresh trail — a real loss, and much smaller than being shown another site's
 * history and having no idea why.
 *
 * Moving between captures INSIDE the viewer is a soft navigation that never
 * unmounts the provider, so the trail carries across those untouched. That is
 * the case it exists for.
 */

export interface ViewTrailEntry {
    /** warc_custom_id — what /warcs/view routes on. */
    id: string;
    url: string;
    contentType?: string | null;
    size?: number | null;
    archivedDate?: string;
}

export interface ViewHistorySnapshot {
    entries: readonly ViewTrailEntry[];
    /** Position of the capture currently on screen, or -1 before the first visit. */
    index: number;
    canGoBack: boolean;
    canGoForward: boolean;
    /** Where Back would go, and where Forward would go. Null when disabled. */
    back: ViewTrailEntry | null;
    forward: ViewTrailEntry | null;
}

const EMPTY: ViewHistorySnapshot = {
    entries: [],
    index: -1,
    canGoBack: false,
    canGoForward: false,
    back: null,
    forward: null,
};

export const createViewHistoryStore = () => {
    const listeners = createListeners();

    let entries: ViewTrailEntry[] = [];
    /** The id currently on screen. Set by `visit`. */
    let current: string | null = null;
    let snapshot: ViewHistorySnapshot = EMPTY;

    const rebuild = () => {
        const index = current === null ? -1 : entries.findIndex(entry => entry.id === current);

        snapshot = {
            entries,
            index,
            canGoBack: index > 0,
            canGoForward: index >= 0 && index < entries.length - 1,
            back: index > 0 ? entries[index - 1]! : null,
            forward: index >= 0 && index < entries.length - 1 ? entries[index + 1]! : null,
        };
    };

    rebuild();

    return {
        subscribe: listeners.subscribe,
        getSnapshot: (): ViewHistorySnapshot => snapshot,

        /*
         * The server snapshot is deliberately the EMPTY one rather than the
         * restored trail.
         *
         * A trail only exists once a reader has navigated, which cannot have
         * happened during a server render — so the server's answer is always the
         * empty one, and saying so explicitly is what keeps the server and the
         * first client render agreeing about a bar with two disabled buttons.
         */
        getServerSnapshot: (): ViewHistorySnapshot => EMPTY,

        /**
         * Record that `entry` is now the capture on screen.
         *
         * Three cases, and the middle one is the one worth naming:
         *
         *   - already current: nothing changed, and emitting would re-render the
         *     whole bar on every re-render of the page.
         *   - already IN the trail: the reader went Back and is somewhere they
         *     have been. Move the cursor, do not append — appending would put the
         *     same capture in the list twice and make Back walk a loop.
         *   - new: everything after the current position is a future that did not
         *     happen, so it is dropped before appending. Same rule a browser uses.
         */
        visit(entry: ViewTrailEntry) {
            if (current === entry.id && snapshot.index >= 0) return;

            const existing = entries.findIndex(item => item.id === entry.id);

            if (existing >= 0) {
                // Refreshed in place: a capture reached by url lookup carries less
                // detail than one the page rendered, and the newer copy is better.
                entries = entries.map((item, at) => (at === existing ? { ...item, ...entry } : item));
            } else {
                const at = current === null ? -1 : entries.findIndex(item => item.id === current);
                entries = at >= 0 ? [...entries.slice(0, at + 1), entry] : [...entries, entry];
            }

            current = entry.id;
            rebuild();
            listeners.emit();
        },

        /** Forget everything. The trail is a session, and a session can be ended. */
        clear() {
            entries = [];
            current = null;
            rebuild();
            listeners.emit();
        },
    };
};

export type ViewHistoryStore = ReturnType<typeof createViewHistoryStore>;
