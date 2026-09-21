'use client';

/**
 * Bringing the reader to the frame when something is about to appear in it.
 *
 * The View buttons live in the tree and the capture panel, both of which sit
 * BELOW the viewer and can be scrolled a long way down — a deep tree is hundreds
 * of rows. Clicking View from down there used to do nothing visible: the page
 * built somewhere off-screen, the progress overlay appeared where it could not
 * be seen, and the frame quietly changed above the fold.
 *
 * A module-level registration rather than a context field or a prop, for the
 * same reason the progress store is one: the callers are scattered, and the
 * alternative is threading a ref through three components that have no other
 * reason to know about each other.
 *
 * Nothing here touches the iframe itself. Focus goes to the WRAPPER, which is a
 * region — moving it into the iframe would put the keyboard inside an archived
 * document, which is not where a reader who just clicked a button wants it.
 */

let viewerElement: HTMLElement | null = null;

/**
 * Room to leave above the frame, matching the `scroll-margin-top: 80px` the rest
 * of the app uses to clear the fixed nav (60px plus its 2px border).
 *
 * Used only to decide whether the frame FITS. The scroll itself defers to the
 * element's own scroll-margin, so the number lives in the stylesheet as well —
 * duplicated on purpose, because reading it back would mean a getComputedStyle
 * on a hot path to learn something that has not changed since it was written.
 */
const NAV_CLEARANCE = 80;

/**
 * Called by the viewer as it mounts. Returns the unregister, so an unmounted
 * viewer cannot be scrolled to.
 */
export const registerArchiveViewer = (element: HTMLElement | null): (() => void) => {
    viewerElement = element;

    return () => {
        // Guarded: a remount registers the new element before the old one's
        // cleanup runs, and an unguarded clear would drop the live registration.
        if (viewerElement === element) viewerElement = null;
    };
};

/**
 * Snap the viewer into view and put focus on it.
 *
 * SYNCHRONOUS, and meant to be called before the rebuild starts. The build is a
 * worker round trip per subresource; doing this after it would mean the reader
 * stares at an unchanged page for the entire time, then gets moved once it is
 * already finished — which is the opposite of the point.
 *
 * ## Snap, not slide
 *
 * globals.css sets `html { scroll-behavior: smooth }`, so this used to animate —
 * and from the bottom of a deep tree that is a long ride past hundreds of rows to
 * somewhere the reader asked to be at once. `behavior: 'instant'` is what
 * overrides a stylesheet; 'auto', and omitting it, both defer to one.
 *
 * ## Centred when it fits, top-aligned when it does not
 *
 * `block: 'center'` alone would be wrong on a short window: centring something
 * taller than the viewport puts its top edge off-screen ABOVE, hiding the address
 * line and the controls, so the reader would be looking at the middle of a
 * document with no way to tell which one. The frame is 70vh with a 480px floor,
 * and that floor is most of the height of a small window.
 */
const scrollToViewer = (element: HTMLElement) => {
    const height = element.getBoundingClientRect().height;
    const viewport = window.innerHeight || document.documentElement.clientHeight;

    // Clearance counted at BOTH ends: centring is only an improvement while there
    // is real room on either side, and the alternative is a "centred" frame whose
    // top edge sits under the nav.
    const fits = height + NAV_CLEARANCE * 2 <= viewport;

    element.scrollIntoView({ block: fits ? 'center' : 'start', behavior: 'instant' });
};

/** Set by a View click, spent by the document arriving. See settleArchiveViewer. */
let recenterPending = false;

export const focusArchiveViewer = () => {
    const element = viewerElement;
    if (!element) return;

    recenterPending = true;

    scrollToViewer(element);

    // preventScroll because scrollIntoView above has already done it, and focus()
    // aligns to `nearest` — which after the scroll above is a no-op, but only by
    // luck, and one that stops being true the moment the frame is taller than the
    // viewport.
    element.focus({ preventScroll: true });
};

/**
 * Centre again, now that the document is actually in the frame.
 *
 * The first scroll happens on the click, before the rebuild, and it has to: the
 * build is a worker round trip per subresource, and moving the reader afterwards
 * would mean they stare at an unchanged page throughout and get taken to the
 * result once it is already there.
 *
 * The cost of being early is that it measures the frame as it was — the tutorial,
 * the empty state, or the failure card — none of which are the height of a
 * document. Centring against that height leaves the document off-centre by the
 * difference the moment it lands. So the click aims, and this corrects.
 *
 * Gated on a flag the click sets, so this ONLY ever fires for a View press.
 * Following a link inside an archived page swaps the document too, and
 * re-centring on that would drag the outer page out from under a reader who had
 * deliberately scrolled it.
 */
export const settleArchiveViewer = (showing: boolean) => {
    if (!recenterPending) return;

    // Spent either way. A miss clears it rather than leaving it armed for
    // whatever happens to change the frame next.
    recenterPending = false;

    const element = viewerElement;
    if (!showing || !element) return;

    scrollToViewer(element);
};
