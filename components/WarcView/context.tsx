'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
    createViewHistoryStore,
    type ViewHistorySnapshot,
    type ViewTrailEntry,
    type ViewHistoryStore,
} from "./history";

/**
 * The /warcs/view trail, shared across the page.
 *
 * Split the way the offline viewer splits its contexts, and for the same reason:
 * the STORE never changes identity, so a component that only wants to record a
 * visit or call clear() can subscribe to it and never re-render. The SNAPSHOT
 * changes on every navigation, so only the address bar pays for it.
 *
 * Both are exposed rather than just the snapshot because the capture list under
 * the frame will want the trail too — to mark the rows a reader has already been
 * to — and it should not have to re-render on every navigation to get it.
 */
const ViewHistoryStoreContext = createContext<ViewHistoryStore | undefined>(undefined);
const ViewHistoryContext = createContext<ViewHistorySnapshot | undefined>(undefined);

export default function ViewHistoryProvider({ children }: { children?: ReactNode }) {
    /*
     * One store per mount, created lazily.
     *
     * `useState(fn)` and not `useState(fn())` — the second form calls the factory
     * on every render and throws the result away, which for this store means
     * re-reading sessionStorage sixty times a page.
     */
    const [store] = useState(createViewHistoryStore);

    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

    return (
        <ViewHistoryStoreContext.Provider value={store}>
            <ViewHistoryContext.Provider value={snapshot}>
                {children}
            </ViewHistoryContext.Provider>
        </ViewHistoryStoreContext.Provider>
    );
}

/** The trail as it stands. Re-renders the caller on every navigation. */
export const useViewHistory = (): ViewHistorySnapshot | undefined => useContext(ViewHistoryContext);

/** The store itself. Stable identity — subscribing to this never re-renders. */
export const useViewHistoryStore = (): ViewHistoryStore | undefined => useContext(ViewHistoryStoreContext);

/**
 * Tell the trail which capture is on screen.
 *
 * In an effect rather than during render, which is the opposite of what the
 * module-scope version did and is the correction. `visit` emits to subscribers,
 * and emitting during render is a "cannot update a component while rendering a
 * different component" warning at best and a loop at worst. An effect runs after
 * paint, so the first frame after a navigation shows the previous Back state for
 * one tick — invisible, and the correct trade for not writing to a store mid-render.
 */
export const useRecordVisit = (entry: ViewTrailEntry): void => {
    const store = useViewHistoryStore();

    // Destructured so the effect keys on the VALUES, not on the object identity
    // the parent rebuilds every render — which would make this run every time.
    const { id, url, contentType, size, archivedDate } = entry;

    useEffect(() => {
        store?.visit({ id, url, contentType, size, archivedDate });
    }, [store, id, url, contentType, size, archivedDate]);
};
