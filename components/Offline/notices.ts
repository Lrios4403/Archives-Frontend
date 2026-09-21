'use client';

/**
 * Non-fatal problems with the document currently on screen.
 *
 * Scoped to ONE view. The store still lives above the viewer — in the provider,
 * so notices survive the viewer unmounting — but the record store clears it on
 * every view transition, and that is deliberate. It used to accumulate across a
 * whole session on the theory that the cumulative set of gaps in an archive is
 * the interesting one, and in use that was wrong: the badge sits in the corner of
 * the frame saying "N resources could not be loaded", so carrying the last five
 * pages' misses into the sixth meant dismissing the same badge on every page and
 * reading it against a document it was not about.
 *
 * Within one view they do accumulate, because they arrive in two waves: the
 * resolver's misses come with the outcome, and the iframe shim's arrive over
 * postMessage while the reader is on the page. The dedupe key is what stops the
 * second wave from re-reporting the first.
 *
 * Fatal errors deliberately do NOT come here. A fatal error means nothing
 * rendered, so it belongs in place of the document, not in a corner badge that
 * a reader might never open.
 */

import { createListeners } from "./store";
import type { MissingRef } from "./view";

export interface WarcNotice extends MissingRef {
    /** Where it was hit, so the table can say which page was being viewed. */
    viewing: string;
    at: Date;
}

/**
 * Upper bound on retained notices.
 *
 * A single generated page can reference thousands of urls that are not in the
 * archive, and an unbounded list would turn a bad page into a memory leak and an
 * unusable table. The oldest go first: what is still missing now is more useful
 * than what was missing twenty pages ago.
 */
const MAX_NOTICES = 500;

export interface WarcNoticeStore {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => readonly WarcNotice[];
    add: (viewing: string, refs: readonly MissingRef[]) => void;
    clear: () => void;
}

export const createWarcNoticeStore = (): WarcNoticeStore => {
    let notices: WarcNotice[] = [];

    // url + reason, NOT url alone: the same asset failing for a different reason
    // later is a different fact, and collapsing them would hide it.
    const seen = new Set<string>();

    const { subscribe, emit } = createListeners();

    return {
        subscribe,

        // A new array identity per change, because useSyncExternalStore compares
        // snapshots by identity — the mutate-in-place trick the record store uses
        // works only because it pairs with an explicit version.
        getSnapshot: () => notices,

        add: (viewing, refs) => {
            const fresh = refs.filter(ref => {
                const key = `${ref.url}::${ref.reason}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            if (fresh.length === 0) return;

            const at = new Date();
            notices = [...notices, ...fresh.map(ref => ({ ...ref, viewing, at }))];

            if (notices.length > MAX_NOTICES) {
                notices = notices.slice(notices.length - MAX_NOTICES);

                // Rebuilt from what SURVIVED, not left to accumulate. `seen` is
                // the dedupe key for what is on screen, and trimming the list
                // without trimming it meant a dropped notice could never be
                // reported again — past 500, the badge silently stopped
                // mentioning resources it had already forgotten about.
                seen.clear();
                for (const notice of notices) seen.add(`${notice.url}::${notice.reason}`);
            }

            emit();
        },

        clear: () => {
            if (notices.length === 0) return;
            notices = [];
            seen.clear();
            emit();
        },
    };
};

/** What each reason means to a reader, rather than to the code. */
export const noticeReasonLabels: Record<MissingRef['reason'], string> = {
    'not-archived': 'Not in this archive',
    'no-payload': 'Captured with no body',
    'unreadable': 'Could not be read from the file',
    'depth-limit': 'Nested too deeply to follow',
    'cycle': 'Stylesheets reference each other in a loop',
    'dynamic': 'Requested by script at runtime',
    'redirect': 'Redirects in a loop, or through too many hops',
    'error-status': 'Already missing when the archive was captured',
};
