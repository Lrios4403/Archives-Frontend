/**
 * The browser's Back button, wired to the archived trail.
 *
 * ## What this replaces
 *
 * Nothing used to connect the two, and the result was worse than Back simply not
 * working. Every archived page is a blob: url put into the iframe, and pointing an
 * iframe at a new url adds an entry to the tab's session history — so the browser
 * accumulated one entry per page the reader visited, each naming a blob. Pressing
 * Back walked the IFRAME to the previous blob, which the store had already revoked
 * the moment it showed the next page. A revoked blob url resolves to nothing, so
 * Back emptied the frame.
 *
 * There are two halves to fixing that, and the iframe half is in the component: it
 * navigates with location.replace, which reuses the current entry instead of adding
 * one. That alone stops Back from breaking. This module is the other half — putting
 * entries there deliberately, one per archived page, so Back has something to
 * consume and lands on the page the reader expects.
 *
 * ## How
 *
 * Each entry carries the trail position it belongs to. Back and Forward then need
 * no bookkeeping of their own: whatever popstate hands over is where the reader now
 * is, and the store rebuilds that record. Going back past the first archived page
 * reaches the entry from before the viewer opened, which carries no position at
 * all — read as "close the viewer", which is what backing out of something means
 * everywhere else.
 *
 * An entry carries the record's id as well as its index, and the id is what the
 * store trusts. The trail is capped, so once a reader passes that cap the oldest
 * entry is dropped and every index below shifts by one — leaving the browser's
 * entries pointing at their neighbours. The id does not shift.
 *
 * Owning entries also means owning what the browser does with the page's scroll
 * position when it travels between them, which it does by default and which is
 * wrong here — see suspendScrollRestoration.
 */

/** Keys on the browser's history state. Namespaced — this is not the only writer. */
const INDEX_KEY = '__warcViewIndex';
const ID_KEY = '__warcViewId';

/** Where a history entry says the reader is. */
export interface ViewHistoryPosition {
    /** Index into the trail when the entry was written. May have shifted since. */
    index: number;
    /** customId of the record, which cannot shift. Null for older entries. */
    id: string | null;
}

const readPosition = (state: unknown): ViewHistoryPosition | null => {
    if (!state || typeof state !== 'object') return null;

    const bag = state as Record<string, unknown>;
    const index = bag[INDEX_KEY];

    if (typeof index !== 'number') return null;

    return { index, id: typeof bag[ID_KEY] === 'string' ? bag[ID_KEY] : null };
};

/**
 * How many entries this module has pushed for the current viewing session.
 *
 * Kept so closing the viewer can unwind them. Without that, ✕ Close would leave a
 * stack of entries pointing into a trail that no longer exists, and Back would then
 * step through them doing nothing visible — a dead button, which reads as a bug
 * rather than as "there is nowhere to go".
 */
let pushed = 0;

/**
 * How many popstates this module is still expecting from its own history.go.
 *
 * history.go reports through popstate, exactly like a real Back press, so unwinding
 * on close would otherwise be indistinguishable from the reader navigating — and
 * would be answered by rebuilding the pages they are trying to leave.
 *
 * A COUNTER, cleared by the event, not a flag cleared on a timer.
 *
 * It was `let unwinding = false` with `setTimeout(() => { unwinding = false }, 0)`,
 * which is a race: `history.go()` dispatches its popstate in a later task than a
 * zero-delay timer, so the suppression expired BEFORE the event it existed to
 * suppress. The event then read as a real Back press that had landed outside the
 * session, and the store's answer to that is to release the view — wiping the fatal
 * error it had set one line earlier. Navigating to an unarchived page closed the
 * viewer and showed the empty state instead of saying what went wrong.
 *
 * Invisible until recently: the popstate subscription was being killed by
 * StrictMode's double-mount, so in development nothing was listening.
 */
let expectedPops = 0;

/** Fallback, for a `go` that lands nowhere and so produces no popstate at all. */
let unwindTimer: number | null = null;

/**
 * The document's scroll restoration mode, borrowed for the viewing session.
 *
 * Null when we are not borrowing it, so a second suspend cannot overwrite the
 * saved value with the 'manual' we ourselves just installed.
 */
let borrowedRestoration: ScrollRestoration | null = null;

const supported = (): boolean =>
    typeof window !== 'undefined' && typeof window.history?.pushState === 'function';

/**
 * Stop the browser moving the OUTER page while the viewer owns history entries.
 *
 * The browser saves a scroll position on every entry and puts it back when the
 * reader travels to one. The entry the viewer opens from was written while the
 * reader was down in the tree — hundreds of rows below the frame, because that is
 * where the View button they clicked lives. So unwinding on a fatal error, or on
 * close, travelled to that entry and the browser dutifully snapped the page back
 * down to the tree, leaving the error message the unwind exists to show sitting
 * off-screen above.
 *
 * ## Why this is set on the way IN, not just around the `go`
 *
 * The mode belongs to the session history ENTRY, not to the document, and the
 * setter writes it on whichever entry is current. Setting 'manual' immediately
 * before `history.go()` therefore marks the entry being LEFT — while the one being
 * travelled TO, whose saved position is the problem, keeps its own 'auto' and is
 * restored anyway. It has to be set while the base entry is still current, which
 * is just before the first push. Entries pushed after that inherit it, which is
 * the same reason the one-line `history.scrollRestoration = 'manual'` at an SPA's
 * startup covers every route it later pushes.
 *
 * Suspending for the whole session rather than only for the unwind is deliberate:
 * stepping Back and Forward through the trail restores a position per entry too,
 * and the outer page twitching while archived pages are rebuilt inside a frame
 * that has not moved is the same complaint in a smaller form.
 */
const suspendScrollRestoration = (): void => {
    if (borrowedRestoration !== null || !supported()) return;

    // Absent in older browsers, in which case there is nothing to suspend and the
    // snap-back is theirs to keep.
    if (typeof window.history.scrollRestoration !== 'string') return;

    borrowedRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
};

/** Hand it back, once the session's entries are gone. */
const resumeScrollRestoration = (): void => {
    if (borrowedRestoration === null) return;

    if (supported() && typeof window.history.scrollRestoration === 'string') {
        window.history.scrollRestoration = borrowedRestoration;
    }

    borrowedRestoration = null;
};

/**
 * Record that the reader has arrived at a page.
 *
 * The url is left exactly as it is. The archived address belongs in the frame's own
 * header, not in the browser's bar: putting it there would mean a reload, or a
 * copied link, appearing to address a page that only exists inside a WARC on this
 * machine.
 */
export const pushViewEntry = (index: number, id: string | null): void => {
    if (!supported()) return;

    // BEFORE the push, so it lands on the entry the viewer was opened from — the
    // one the unwind travels back to. See suspendScrollRestoration.
    suspendScrollRestoration();

    window.history.pushState(
        { ...(window.history.state as object | null), [INDEX_KEY]: index, [ID_KEY]: id },
        '',
    );

    pushed++;
};

/**
 * Drop every entry this session added, returning the cursor to where the reader was
 * before they opened anything.
 *
 * Deliberately silent: the callback is suppressed for the popstate this causes,
 * because the store has already released the view by the time it fires.
 */
export const unwindViewEntries = (): void => {
    const steps = pushed;
    pushed = 0;

    if (!supported() || steps <= 0) {
        // Nothing to travel to, so nothing will restore a scroll position — and a
        // suspension left in place would outlive the session that asked for it.
        resumeScrollRestoration();

        return;
    }

    // ONE popstate, however many entries are unwound: history.go(-n) reports a
    // single move, not one per entry.
    expectedPops += 1;
    window.history.go(-steps);

    /*
     * A safety net, not the mechanism.
     *
     * There is no event for "go finished" other than the popstate it produces, and
     * a go that lands nowhere produces none at all — so a counter decremented only
     * by the handler could stay positive forever and swallow the reader's next real
     * Back press.
     *
     * Generous rather than zero-delay. The previous version cleared this after
     * setTimeout(0), which fires BEFORE the popstate history.go dispatches, so the
     * suppression was reliably gone by the time it was needed. 500 ms is far longer
     * than a same-document history move and far shorter than a reader deciding to
     * press Back.
     */
    if (unwindTimer !== null) window.clearTimeout(unwindTimer);

    unwindTimer = window.setTimeout(() => {
        expectedPops = 0;
        unwindTimer = null;
        resumeScrollRestoration();
    }, 500);
};

/**
 * Listen for the reader moving through the entries above.
 *
 * The position is null for an entry from before the viewer was opened, which means
 * they have backed all the way out.
 */
export const subscribeToViewHistory = (
    onMove: (position: ViewHistoryPosition | null) => void,
): (() => void) => {
    if (typeof window === 'undefined') return () => {};

    const onPopState = (event: PopStateEvent) => {
        // Ours, not the reader's. Consumed rather than tested, so the suppression
        // lasts exactly as long as the event it is for takes to arrive.
        if (expectedPops > 0) {
            expectedPops -= 1;

            if (expectedPops === 0) {
                if (unwindTimer !== null) {
                    window.clearTimeout(unwindTimer);
                    unwindTimer = null;
                }

                // The traversal has landed, so the entry whose saved position was
                // the problem is behind us and the mode can go back to the reader's.
                resumeScrollRestoration();
            }

            return;
        }

        onMove(readPosition(event.state));
    };

    window.addEventListener('popstate', onPopState);

    return () => window.removeEventListener('popstate', onPopState);
};

/**
 * Step the browser rather than the store.
 *
 * The in-frame arrows call these, so that they and the browser's own buttons move
 * the SAME cursor. The alternative — arrows that step the store directly — leaves
 * the two out of step after one press, and from then on the browser's Back lands
 * somewhere neither of them predicted.
 *
 * Returns false when there is no browser entry to move through, so a caller can
 * fall back to stepping the store directly.
 */
export const goBackThroughBrowser = (): boolean => {
    if (!supported() || pushed <= 0) return false;

    window.history.back();

    return true;
};

export const goForwardThroughBrowser = (): boolean => {
    if (!supported() || pushed <= 0) return false;

    window.history.forward();

    return true;
};

/** Test seam: the module holds process-wide state, so a suite has to reset it. */
export const __resetBrowserHistory = (): void => {
    pushed = 0;
    expectedPops = 0;

    if (unwindTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(unwindTimer);
    }

    unwindTimer = null;

    // Dropped rather than handed back: a suite installs a fresh window stub per
    // test, so the history this was borrowed from no longer exists.
    borrowedRestoration = null;
};

/** Test seam: popstates still expected from our own history.go. */
export const __expectedPops = (): number => expectedPops;

/** Test seam: how many entries are outstanding. */
export const __pushedEntries = (): number => pushed;

/** Test seam: the mode we are holding, or null when we are holding none. */
export const __borrowedRestoration = (): ScrollRestoration | null => borrowedRestoration;
