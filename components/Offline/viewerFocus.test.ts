// bun test components/Offline/viewerFocus.test.ts
//
// Where the View button puts the reader.
//
// Two things are pinned here, and both are one-word arguments to scrollIntoView
// that no type checker can get wrong for you:
//
//   behavior — 'instant', because globals.css sets html { scroll-behavior: smooth }
//              and anything else defers to it. From the bottom of a deep tree the
//              deferred version is a long animated ride past hundreds of rows.
//
//   block    — 'center' when the frame fits with room at both ends, 'start' when it
//              does not. Centring something taller than the viewport pushes its top
//              edge off-screen ABOVE, hiding the address line and the controls.

import { beforeEach, describe, expect, test } from "bun:test";
import { focusArchiveViewer, registerArchiveViewer, settleArchiveViewer } from "./viewerFocus";

interface Recorded {
    scrolls: ScrollIntoViewOptions[];
    focuses: (FocusOptions | undefined)[];
}

/** A stand-in for the frame wrapper, of a stated height. */
const element = (height: number): { node: HTMLElement; log: Recorded } => {
    const log: Recorded = { scrolls: [], focuses: [] };

    const node = {
        getBoundingClientRect: () => ({ height }) as DOMRect,
        scrollIntoView: (options: ScrollIntoViewOptions) => { log.scrolls.push(options); },
        focus: (options?: FocusOptions) => { log.focuses.push(options); },
    };

    return { node: node as unknown as HTMLElement, log };
};

const viewport = (height: number) => {
    (globalThis as Record<string, unknown>).window = { innerHeight: height };
    (globalThis as Record<string, unknown>).document = {
        documentElement: { clientHeight: height },
    };
};

beforeEach(() => {
    viewport(900);
    registerArchiveViewer(null);
});

describe("focusArchiveViewer", () => {
    test("snaps rather than sliding", () => {
        const { node, log } = element(600);
        registerArchiveViewer(node);

        focusArchiveViewer();

        expect(log.scrolls).toHaveLength(1);
        expect(log.scrolls[0]?.behavior).toBe("instant");
    });

    test("centres a frame with room at both ends", () => {
        // 600 + 80 above + 80 below = 760, inside a 900px viewport.
        const { node, log } = element(600);
        registerArchiveViewer(node);

        focusArchiveViewer();

        expect(log.scrolls[0]?.block).toBe("center");
    });

    test("top-aligns a frame taller than the viewport", () => {
        // The 480px floor on a 500px window: centring would put the address line
        // and the controls above the top edge of the screen.
        viewport(500);

        const { node, log } = element(480);
        registerArchiveViewer(node);

        focusArchiveViewer();

        expect(log.scrolls[0]?.block).toBe("start");
    });

    test("top-aligns when it fits but the clearance does not", () => {
        // Fits outright (800 < 900) yet centring would leave 50px at each end —
        // less than the 62px nav, so the address line would sit under it.
        const { node, log } = element(800);
        registerArchiveViewer(node);

        focusArchiveViewer();

        expect(log.scrolls[0]?.block).toBe("start");
    });

    test("focus does not scroll a second time", () => {
        const { node, log } = element(600);
        registerArchiveViewer(node);

        focusArchiveViewer();

        expect(log.focuses).toEqual([{ preventScroll: true }]);
    });

    test("an unregistered viewer is not scrolled to", () => {
        const { node, log } = element(600);
        const unregister = registerArchiveViewer(node);

        unregister();
        focusArchiveViewer();

        expect(log.scrolls).toEqual([]);
        expect(log.focuses).toEqual([]);
    });

    test("centres AGAIN once the document has landed", () => {
        // The click measures the frame as it is — an empty state, not a document —
        // so the first centring is against the wrong height. Without the second
        // pass the document sits off-centre by the difference.
        const empty = element(200);
        registerArchiveViewer(empty.node);

        focusArchiveViewer();
        expect(empty.log.scrolls).toHaveLength(1);

        settleArchiveViewer(true);
        expect(empty.log.scrolls).toHaveLength(2);
    });

    test("does not centre again for anything the reader did not press View for", () => {
        const { node, log } = element(600);
        registerArchiveViewer(node);

        // No focusArchiveViewer: this is a link followed inside an archived page,
        // which swaps the document too. Re-centring there would drag the outer
        // page out from under a reader who had scrolled it on purpose.
        settleArchiveViewer(true);

        expect(log.scrolls).toEqual([]);
    });

    test("a miss spends the arming without scrolling", () => {
        const { node, log } = element(600);
        registerArchiveViewer(node);

        focusArchiveViewer();
        expect(log.scrolls).toHaveLength(1);

        // Nothing is showing — the failure card replaced the frame's contents, and
        // moving the page then is the complaint this pair of fixes is about.
        settleArchiveViewer(false);
        expect(log.scrolls).toHaveLength(1);

        // And it is spent, not left armed for whatever changes the frame next.
        settleArchiveViewer(true);
        expect(log.scrolls).toHaveLength(1);
    });

    // A remount registers the new element before the old one's cleanup runs, and an
    // unguarded clear would drop the live registration — leaving View silent.
    test("a remount's registration survives the old cleanup", () => {
        const first = element(600);
        const second = element(600);

        const stopFirst = registerArchiveViewer(first.node);
        registerArchiveViewer(second.node);
        stopFirst();

        focusArchiveViewer();

        expect(second.log.scrolls).toHaveLength(1);
        expect(first.log.scrolls).toEqual([]);
    });
});
