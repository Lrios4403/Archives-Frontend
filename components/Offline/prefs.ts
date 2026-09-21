'use client';

import { useSyncExternalStore } from "react";

/**
 * The things a reader can tell the viewer to stop doing — for this visit.
 *
 * Both are about redirects, and both exist because the right default is
 * arguable. A 3xx with a body is a page somebody's server sent — a "Moved
 * Permanently" stub, a "click here if you are not redirected", a whole
 * interstitial — and skipping it hides part of what was captured; but a reader
 * who has seen a hundred stubs wants them gone. So the viewer WAITS on a bodied
 * redirect by default and lets the reader switch that off.
 *
 * SESSION-SCOPED, ON PURPOSE. These began in localStorage and were changed at
 * the owner's request: "Don't show again" means "not again while I am here",
 * not "never again on this machine". A refresh, or leaving the viewer for
 * another page, puts both back to their defaults. That is the better shape
 * twice over. The bars are the viewer telling you what it just did with your
 * click, and a choice made while skimming one archive should not silently shape
 * how the next one behaves a week later. And a preference that outlives the
 * page needs a settings surface to undo it, which a reader who clicked by
 * mistake would have to go looking for — here the undo is the "Show them again"
 * line in the empty state, or simply a reload.
 *
 * Plain module state. No storage of any kind is touched.
 */
export interface OfflinePrefs {
    /**
     * Follow a redirect even when it carries a body, without asking. Set by
     * "Don't show again" on the "Redirecting to" bar.
     */
    followRedirectsWithBody: boolean;

    /**
     * Do not show the "Redirected from" bar after a redirect was followed. Set
     * by "Don't show again" on that bar.
     */
    hideRedirectedNotice: boolean;
}

const DEFAULTS: OfflinePrefs = {
    followRedirectsWithBody: false,
    hideRedirectedNotice: false,
};

// One object, replaced on write. useSyncExternalStore compares snapshots by
// identity, so getPrefs must hand back the SAME object until something changes.
let current: OfflinePrefs = DEFAULTS;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(listener => listener());

export const getPrefs = (): OfflinePrefs => current;

export const setPref = <K extends keyof OfflinePrefs>(key: K, value: OfflinePrefs[K]): void => {
    if (current[key] === value) return;
    current = { ...current, [key]: value };
    emit();
};

/**
 * Back to defaults. Called when the viewer unmounts — the reader has left the
 * page — and by "Show them again". A reload gets here on its own, since the
 * module is re-evaluated.
 */
export const resetPrefs = (): void => {
    if (current === DEFAULTS) return;
    current = DEFAULTS;
    emit();
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** The preferences, live: the caller re-renders when any of them changes. */
export const usePrefs = (): OfflinePrefs => useSyncExternalStore(subscribe, getPrefs, () => DEFAULTS);
