'use client';

/**
 * The counts drawn in the Load archives and Records titlebars.
 *
 * Two very small client components rather than props on the page, because
 * app/warcs/offline/page.tsx is a server component and these numbers live in the
 * store. Passing them as Window's `meta` is what puts them on the bar.
 *
 * On the BAR rather than in the body, deliberately: both windows now cap their
 * height and scroll, so a total sitting above a scroll pane is the first thing to
 * disappear. The titlebar is the one place a count cannot be scrolled away from.
 */

import { useContext, useMemo, useSyncExternalStore } from "react";
import { WarcFilesContext, WarcRecordContext } from "./context";
import { RECORD_COUNT_KEY } from "./tree";
import type { WarcTreeVersions } from "./types";

/** For a component rendered outside a provider. Never fires, so never re-renders. */
const neverSubscribe = () => () => { };

/**
 * Wake on every record accepted, and only on that.
 *
 * WarcRecordContext is the store's STABLE half: its own docstring says "a
 * component reading this context is never re-rendered by the store at all, which
 * is the entire reason the context was split". `recordEntries` is mutated in
 * place, so reading `recordCount` off it gives a number that changes without React
 * ever hearing about it — which is why this count rendered once, at zero, and
 * stayed there.
 *
 * So it subscribes the way tree rows do: one keyed listener, woken by the flush
 * that drains dirtyTreeUrls. Per-key rather than the global emit because the
 * global emit during a parse is the whole-world wake the split store exists to
 * avoid.
 */
const useRecordCountVersion = (versions: WarcTreeVersions | undefined): number => {
    // Memoised on the store, because useSyncExternalStore resubscribes whenever
    // the subscribe function's identity changes — a fresh closure per render would
    // tear down and rebuild the listener sixty times a second.
    const subscribe = useMemo(
        () => versions?.subscribeTo(RECORD_COUNT_KEY) ?? neverSubscribe,
        [versions],
    );

    return useSyncExternalStore(
        subscribe,
        () => versions?.versionOf(RECORD_COUNT_KEY) ?? 0,
        () => 0,
    );
};

/**
 * Built once. `toLocaleString()` constructs a fresh Intl.NumberFormat per call,
 * and these re-render on every store flush — sixty times a second during a parse.
 * The same reasoning as COUNT_FORMAT in fileListing.
 */
const COUNT = new Intl.NumberFormat();

/** "6 files", or nothing at all before anything is picked. */
export function WarcOfflineFileCount() {
    const selection = useContext(WarcFilesContext);
    const files = selection?.fileHandles.length ?? 0;

    // Nothing rather than "0 files": an empty window already reads as empty, and a
    // zero on the bar is noise that never goes away until the reader acts.
    if (files === 0) return null;

    return <>{`${COUNT.format(files)} ${files === 1 ? 'file' : 'files'}`}</>;
}

/**
 * "7,274 total", plus how many of those are captures worth browsing.
 *
 * Both numbers, because they answer different questions and the difference
 * between them is routinely large: a WARC pairs a request with every response, and
 * Browsertrix adds revisit and crawler-metadata records on top. On the archive on
 * hand 7,274 records carry 3,050 responses — reporting only the first would
 * overstate what there is to read by well over double.
 */
export function WarcOfflineRecordCount() {
    const context = useContext(WarcRecordContext);

    // Read for the re-render, not for the value. The counts themselves come off
    // the mutated store below; this is the only thing telling React they moved.
    useRecordCountVersion(context?.treeVersions);

    const entries = context?.recordEntries;
    const records = entries?.recordCount ?? 0;

    if (records === 0) return null;

    const responses = entries?.responseCount ?? 0;

    return (
        <>
            {`${COUNT.format(records)} total`}
            {responses > 0 && responses !== records && ` · ${COUNT.format(responses)} pages`}
        </>
    );
}
