// bun test components/WarcSearch/resultsQuery.test.ts
//
// The pager's page count and the `?page=` clamp, which have to be the same
// number and used not to be.
//
// MAX_PAGE was computed here from CAPPED_TOTAL, and WarcSearchResults computed
// its own `Math.max(1, Math.ceil(totalSites / PAGE_SIZE))` in another file
// without ever looking at MAX_PAGE. Nothing tied them together, so they agreed
// only for as long as nobody edited one of them. normalizePage clamps the
// incoming page to MAX_PAGE, which makes a disagreement invisible rather than
// loud: lower the cap on its own and the pager keeps offering the old page
// numbers, every request for one of them comes back to the cap, and a long run
// of distinct URLs serve byte-identical rows while each still links onward.
//
// So the property under test is not "626 is the right number". It is that the
// pager cannot offer a page the clamp will refuse to honour, whatever either
// number is changed to.

import { describe, expect, test } from "bun:test";
import { MAX_PAGE, PAGE_SIZE, normalizePage, pageCount } from "./resultsQuery";

/** Totals worth checking: the boundaries, plus the capped-count value itself. */
const TOTALS = [
    0,
    1,
    PAGE_SIZE - 1,
    PAGE_SIZE,
    PAGE_SIZE + 1,
    MAX_PAGE * PAGE_SIZE - 1,
    MAX_PAGE * PAGE_SIZE,
    MAX_PAGE * PAGE_SIZE + 1,
    10_001,
    3_592_000,
];

describe("pageCount and MAX_PAGE agree by construction", () => {
    test("the pager never offers a page past the clamp", () => {
        for (const total of TOTALS) {
            expect(pageCount(total)).toBeLessThanOrEqual(MAX_PAGE);
        }
    });

    test("every page the pager links to survives normalizePage unchanged", () => {
        // The actual regression. If normalizePage sends a linked page somewhere
        // else, that page renders another page's rows under its own URL.
        for (const total of TOTALS) {
            const last = pageCount(total);
            for (const page of [1, Math.ceil(last / 2), last - 1, last]) {
                if (page < 1) continue;
                expect(normalizePage(String(page))).toBe(page);
            }
        }
    });

    test("MAX_PAGE is exactly what pageCount answers for an unbounded result", () => {
        // Which is the statement "these two are one number", written as a test.
        expect(pageCount(Number.MAX_SAFE_INTEGER)).toBe(MAX_PAGE);
        expect(pageCount(Number.POSITIVE_INFINITY)).toBe(MAX_PAGE);
    });

    test("lowering the cap lowers the pager with it", () => {
        // Can't reassign the constant, so assert the relationship that makes the
        // drift unexpressible: pageCount is the clamp applied to the arithmetic,
        // not a second copy of the arithmetic.
        for (const total of TOTALS) {
            const unclamped = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);
            expect(pageCount(total)).toBe(Math.min(unclamped, MAX_PAGE));
        }
    });
});

describe("pageCount edge cases", () => {
    test("an empty or absent result is one page, not zero", () => {
        // Zero would make Pagination's `totalPages <= 1` guard fire on a
        // different value than the header's "page 1 of 0".
        expect(pageCount(0)).toBe(1);
        expect(pageCount(-5)).toBe(1);
        expect(pageCount(Number.NaN)).toBe(1);
    });

    test("a partial page still counts as a page", () => {
        expect(pageCount(1)).toBe(1);
        expect(pageCount(PAGE_SIZE)).toBe(1);
        expect(pageCount(PAGE_SIZE + 1)).toBe(2);
    });

    test("the capped count is the cap, not one page past it", () => {
        // total_count comes back as 10_001 to mean "more than 10,000", and the
        // pager has to land on the same page number the clamp was built from.
        expect(pageCount(10_001)).toBe(MAX_PAGE);
    });
});

describe("normalizePage", () => {
    test("clamps to the same ceiling the pager stops at", () => {
        expect(normalizePage(String(MAX_PAGE + 1))).toBe(MAX_PAGE);
        expect(normalizePage("999999")).toBe(MAX_PAGE);
    });

    test("floors to a whole page and to at least 1", () => {
        expect(normalizePage("1.5")).toBe(1);
        expect(normalizePage("0")).toBe(1);
        expect(normalizePage("-3")).toBe(1);
        expect(normalizePage(undefined)).toBe(1);
        expect(normalizePage("not a page")).toBe(1);
    });
});
