// bun test components/Offline/browserHistory.test.ts
//
// Suppressing our OWN popstate, which is the thing that went wrong.
//
// unwindViewEntries drops the entries a viewing session pushed, and history.go
// reports that through popstate exactly like a real Back press. The suppression
// used to be a flag cleared on setTimeout(0) — which fires BEFORE the popstate
// history.go dispatches, so it was reliably gone by the time it was needed.
//
// The consequence was not a dead Back button but a lost error message: the store
// unwinds history when it shows a fatal failure, the unsuppressed popstate read as
// "backed out of the session", and the store's answer to that is to release the
// view — erasing the failure it had set one line earlier. Navigating to an
// unarchived page closed the viewer and showed the empty state.
//
// The second half of the file is the same unwind seen from the other side: even
// suppressed, the traversal still let the browser restore the target entry's
// scroll position, snapping the page back down to the tree.

import { beforeEach, describe, expect, test } from "bun:test";
import {
    __borrowedRestoration,
    __expectedPops,
    __pushedEntries,
    __resetBrowserHistory,
    pushViewEntry,
    subscribeToViewHistory,
    unwindViewEntries,
} from "./browserHistory";

/** What `scrollRestoration` was set to at the moment each push happened. */
let modeAtPush: string[] = [];

/**
 * A history stand-in whose `go` dispatches popstate in a LATER task than a
 * zero-delay timer — which is what real browsers do, and the whole reason the
 * original suppression failed.
 */
const installHistory = () => {
    const entries: unknown[] = [null];
    let cursor = 0;
    let listener: ((event: { state: unknown }) => void) | null = null;

    modeAtPush = [];

    const history = {
        scrollRestoration: "auto" as string,
        pushState: (state: unknown) => {
            // Recorded because the ORDERING is the fix: the mode is a property of
            // the entry being left, so it has to already be 'manual' here.
            modeAtPush.push(history.scrollRestoration);

            entries.length = cursor + 1;
            entries.push(state);
            cursor++;
        },
        replaceState: (state: unknown) => { entries[cursor] = state; },
        go: (delta: number) => {
            cursor = Math.max(0, Math.min(entries.length - 1, cursor + delta));

            // Two macrotask hops, so it lands after any setTimeout(…, 0)
            // registered by the caller. Real browsers are at least this late.
            setTimeout(() => setTimeout(() => listener?.({ state: entries[cursor] }), 0), 0);
        },
        forward: () => { cursor = Math.min(entries.length - 1, cursor + 1); },
    };

    (globalThis as Record<string, unknown>).window = {
        history,
        addEventListener: (type: string, fn: (event: { state: unknown }) => void) => {
            if (type === "popstate") listener = fn;
        },
        removeEventListener: () => { listener = null; },
        setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
        clearTimeout: (id: number) => clearTimeout(id as unknown as Timer),
    };

    return history;
};

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

let stub: ReturnType<typeof installHistory>;

beforeEach(() => {
    stub = installHistory();
    __resetBrowserHistory();
});

describe("unwinding our own entries", () => {
    test("the popstate from our own history.go is not reported", async () => {
        const moves: unknown[] = [];
        const stop = subscribeToViewHistory(position => moves.push(position));

        pushViewEntry(0, "a");
        pushViewEntry(1, "b");
        expect(__pushedEntries()).toBe(2);

        unwindViewEntries();

        // The suppression must still be in force when the event arrives, which is
        // the assertion the old timer-based version failed.
        await settle();

        expect(moves).toEqual([]);
        expect(__expectedPops()).toBe(0);

        stop();
    });

    test("a real Back press afterwards IS reported", async () => {
        const moves: unknown[] = [];
        const stop = subscribeToViewHistory(position => moves.push(position));

        pushViewEntry(0, "a");
        unwindViewEntries();
        await settle();

        expect(moves).toEqual([]);

        // Now the reader presses Back for real. The suppression must be spent, not
        // still swallowing events — the failure mode the fallback timer exists for.
        pushViewEntry(0, "a");
        (globalThis as any).window.history.go(-1);
        await settle();

        expect(moves.length).toBe(1);

        stop();
    });

    test("unwinding with nothing pushed expects no popstate", () => {
        unwindViewEntries();

        expect(__expectedPops()).toBe(0);
    });

    // A `go` that lands nowhere produces no popstate at all, so the counter would
    // stay positive forever and swallow the reader's next real Back press. The
    // fallback timer is what stops that.
    test("the fallback clears a suppression that never gets its event", async () => {
        const moves: unknown[] = [];
        const stop = subscribeToViewHistory(position => moves.push(position));

        pushViewEntry(0, "a");

        // Silence `go` entirely: the popstate never comes.
        (globalThis as any).window.history.go = () => { };
        unwindViewEntries();

        expect(__expectedPops()).toBe(1);

        await new Promise(resolve => setTimeout(resolve, 600));

        expect(__expectedPops()).toBe(0);

        stop();
    });
});

/*
 * The other thing owning history entries drags in: the browser saves a scroll
 * position on every entry and puts it back on the way to one.
 *
 * The entry the viewer opens from was written while the reader was down in the
 * tree, because that is where the View button lives. So the unwind travelled
 * there and the page snapped back down to the tree — with the error message the
 * unwind exists to show now off-screen above it.
 */
describe("scroll restoration", () => {
    test("suspended BEFORE the first push, not around the go", () => {
        pushViewEntry(0, "a");

        // The mode belongs to the entry being LEFT. Set after the push — or worse,
        // just before history.go — it marks the wrong entry and the one actually
        // travelled to keeps its own 'auto' and is restored anyway.
        expect(modeAtPush).toEqual(["manual"]);
        expect(stub.scrollRestoration).toBe("manual");
        expect(__borrowedRestoration()).toBe("auto");
    });

    test("stays suspended for the whole session, across every push", () => {
        pushViewEntry(0, "a");
        pushViewEntry(1, "b");
        pushViewEntry(2, "c");

        // Not re-borrowed each time: a second suspend would save the 'manual' we
        // installed ourselves, and there would be no 'auto' left to hand back.
        expect(modeAtPush).toEqual(["manual", "manual", "manual"]);
        expect(__borrowedRestoration()).toBe("auto");
    });

    test("handed back once the unwind has landed", async () => {
        const stop = subscribeToViewHistory(() => { });

        pushViewEntry(0, "a");
        pushViewEntry(1, "b");
        unwindViewEntries();

        // Still ours while the traversal is in flight — releasing it before the
        // event would let the browser restore on the way out, which is the bug.
        expect(stub.scrollRestoration).toBe("manual");

        await settle();

        expect(stub.scrollRestoration).toBe("auto");
        expect(__borrowedRestoration()).toBeNull();

        stop();
    });

    test("handed back by the fallback when the go produces no event", async () => {
        const stop = subscribeToViewHistory(() => { });

        pushViewEntry(0, "a");
        stub.go = () => { };
        unwindViewEntries();

        await new Promise(resolve => setTimeout(resolve, 600));

        expect(stub.scrollRestoration).toBe("auto");
        expect(__borrowedRestoration()).toBeNull();

        stop();
    });

    test("unwinding with nothing pushed leaves nothing borrowed", () => {
        unwindViewEntries();

        expect(stub.scrollRestoration).toBe("auto");
        expect(__borrowedRestoration()).toBeNull();
    });

    // Whatever the app had set is what goes back, not a hardcoded 'auto'.
    test("the reader's own mode is restored, not a default", async () => {
        stub.scrollRestoration = "manual";

        const stop = subscribeToViewHistory(() => { });

        pushViewEntry(0, "a");
        unwindViewEntries();
        await settle();

        expect(stub.scrollRestoration).toBe("manual");

        stop();
    });
});
