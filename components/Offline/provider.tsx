'use client';

import { ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { WarcFilesContext, WarcRecordContext, WarcViewContext } from "./context";
import { cancelDownload, saveDownloadedBlob } from "./download";
import WarcOfflineDownloadNotifications from "./downloadNotification";
import { createWarcRecordStore } from "./store";

export default function OfflineContextProvider({
  children,
}: {
  children?: ReactNode
}) {

    // A store per mount, rather than the module-level singleton this used to
    // pass straight through as `value`. Two problems with the singleton: it
    // outlived the provider, so a remount inherited the previous session's
    // records, and passing a mutated object as `value` never changed its
    // identity — so pushRecord and setFileHandles updated the data and React
    // re-rendered nothing.
    const [store] = useState(createWarcRecordStore);

    /**
     * Three subscriptions, one per slice.
     *
     * All three share ONE subscribe — a flush wakes them together and each
     * compares its own snapshot by identity, so a slice that did not change
     * costs a comparison and nothing else. That is what makes the split work
     * without three notification channels.
     *
     * `value` in particular never changes identity at all, so its Provider never
     * notifies anyone. During a parse this component re-renders only when a view
     * or the selection moves, and `children` comes in as a prop, so React bails
     * out of the subtree anyway.
     *
     * Third argument is the server snapshot: the same getter, since nothing
     * mutates the store until a browser event does.
     */
    const value = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const view = useSyncExternalStore(store.subscribe, store.getViewSnapshot, store.getViewSnapshot);
    const files = useSyncExternalStore(store.subscribe, store.getFilesSnapshot, store.getFilesSnapshot);

    /**
     * Give back the blob urls when the page goes away.
     *
     * Every blob url pins its Blob until revoked, and a rebuilt page holds one
     * per subresource — so leaving the offline page with a document showing used
     * to strand the whole thing, with nothing left able to reach it. The store
     * owns the revoke, so the store is what gets told.
     */
    useEffect(() => store.dispose, [store]);

    /*
     * Back and Forward, subscribed here rather than at store construction.
     *
     * The store used to subscribe eagerly and unsubscribe inside `dispose`, which
     * the effect above runs as its cleanup — so StrictMode's mount/unmount/remount
     * killed the popstate listener on the first cycle and nothing re-established
     * it. Browser navigation was dead in development, on a store that otherwise
     * behaved. An effect that starts what its own cleanup stops cannot get into
     * that state.
     */
    useEffect(() => store.startHistory(), [store]);

    // The notice badge used to be rendered here, fixed to the bottom-left of the
    // viewport. It now lives in the viewer, pinned to the corner of the frame it
    // is describing — see iframe.tsx. Anchoring it to the window meant it sat far
    // from whatever the reader was looking at, and on a page tall enough to
    // scroll it was easy to miss entirely.
    //
    // The STORE still lives here, so notices survive the viewer unmounting — but
    // they are scoped to one view: the record store clears them on every
    // transition. See the note in notices.ts for why cumulative was wrong.
    return <WarcRecordContext.Provider value={value}>
        <WarcViewContext.Provider value={view}>
            <WarcFilesContext.Provider value={files}>
                {children}

                {/*
                  * The download cards, at the SESSION level rather than inside
                  * the viewer.
                  *
                  * Deliberately the opposite of the move the notice badge made:
                  * that went out of here and into the frame because it describes
                  * the document on screen. A download belongs to the session and
                  * carries on after that document is closed, so anchoring it to
                  * the frame would mean a running download vanishing the moment
                  * the reader pressed ✕ Close.
                  */}
                <WarcOfflineDownloadNotifications
                    downloads={value.downloads}
                    onCancel={cancelDownload}
                    onSave={saveDownloadedBlob}
                />
            </WarcFilesContext.Provider>
        </WarcViewContext.Provider>
    </WarcRecordContext.Provider>
}
