// bun test components/WarcSearch/timeline.test.ts
//
// The rule that decides whether a timeline is drawn at all.
//
// Worth testing on its own because the decision and the drawing are in
// different files: SiteResults and the offline capture list both ask "how many
// bars would this produce" before rendering the widget, and if their answer
// stops matching the widget's own bucketing the result is a 195px panel
// containing one column — the exact thing the check exists to prevent.

import { describe, expect, test } from "bun:test";
import { dayKeyOf, distinctDays } from "./timeline";

/** A record at a given local time, which is what the chart buckets on. */
const at = (year: number, month: number, day: number, hour = 12) => ({
    dateArchived: new Date(year, month - 1, day, hour).toISOString(),
});

describe("dayKeyOf", () => {
    test("keys on the LOCAL day, not the UTC one", () => {
        // The widget groups with getFullYear/getMonth/getDate, so a capture at
        // 02:34Z in a positive-offset zone belongs to the local date. Building
        // the key from toISOString() would put it on the previous day and the
        // bar count would disagree with the bars.
        const local = new Date(2026, 0, 15, 2, 34);

        expect(dayKeyOf(local.toISOString())).toBe("2026-01-15");
    });

    test("pads, so keys sort lexicographically", () => {
        expect(dayKeyOf(new Date(2026, 2, 4, 12).toISOString())).toBe("2026-03-04");
    });

    test("two times on one day share a key", () => {
        expect(dayKeyOf(at(2026, 5, 9, 1).dateArchived))
            .toBe(dayKeyOf(at(2026, 5, 9, 23).dateArchived));
    });
});

describe("distinctDays", () => {
    test("no records, no bars", () => {
        expect(distinctDays([])).toBe(0);
    });

    test("one capture is one bar", () => {
        expect(distinctDays([at(2026, 1, 1)])).toBe(1);
    });

    /*
     * The case that motivated all of this. On the search page a url with
     * fourteen captures drew a chart; every one of them landed on the same
     * afternoon, so the chart was a single column labelled "1 days · 14 records".
     */
    test("many captures on one day are still one bar", () => {
        const sameDay = Array.from({ length: 14 }, (_, i) => at(2026, 1, 1, i + 1));

        expect(sameDay).toHaveLength(14);
        expect(distinctDays(sameDay)).toBe(1);
    });

    test("counts days, and only counts each once", () => {
        expect(distinctDays([at(2026, 1, 1), at(2026, 1, 2), at(2026, 1, 1)])).toBe(2);
    });

    test("crossing a month and a year boundary still counts as separate days", () => {
        expect(distinctDays([at(2025, 12, 31), at(2026, 1, 1)])).toBe(2);
    });

    // The threshold both call sites actually use, stated once so a change to it
    // has to change a test that says why.
    test("the > 1 threshold separates a real chart from an empty one", () => {
        const oneDay = [at(2026, 1, 1, 9), at(2026, 1, 1, 17)];
        const twoDays = [at(2026, 1, 1), at(2026, 1, 2)];

        expect(distinctDays(oneDay) > 1).toBe(false);
        expect(distinctDays(twoDays) > 1).toBe(true);
    });

    test("an unparseable date does not throw or collapse everything into one bar", () => {
        // A bad row should not be able to hide a chart that other rows earn.
        const mixed = [{ dateArchived: "not a date" }, at(2026, 1, 1), at(2026, 1, 2)];

        expect(() => distinctDays(mixed)).not.toThrow();
        expect(distinctDays(mixed)).toBeGreaterThan(1);
    });
});
