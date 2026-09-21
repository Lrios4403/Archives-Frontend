// bun test components/Offline/records.test.ts
//
// The running totals and the wake that makes them visible.
//
// Both exist because of one bug: the Records titlebar count rendered once, at
// zero, and never again. WarcRecordContext is the store's STABLE half — its own
// docstring says "a component reading this context is never re-rendered by the
// store at all, which is the entire reason the context was split" — so reading a
// count off the mutated recordEntries gives a number React never hears about.
//
// The fix is a keyed wake, the same mechanism tree rows use. These tests pin both
// halves: that the numbers are right, and that something is told.

import { describe, expect, test } from "bun:test";
import { createRecordEntries, pushRecord } from "./records";
import { RECORD_COUNT_KEY, TREE_SHAPE_KEY } from "./tree";
import type { WarcFileHande, WarcRecord, WarcRecordEntries } from "./types";

const handle = {
    name: "t.warc.gz", size: 1, parsedOffset: 0,
    file: new File([new Uint8Array(1)], "t.warc.gz"),
} as WarcFileHande;

let unique = 0;

const record = (url: string, type: WarcRecord["type"] = "response"): WarcRecord => {
    const uuid = `u${unique++}`;

    return {
        uuid, url,
        dateArchived: new Date(0), lastArchived: new Date(0),
        contentType: "text/html", fileHandle: handle,
        customId: `${handle.name}::${url}::${uuid}`,
        type, offset: 0, length: 0,
        ip: null, concurrentTo: null, refersTo: null,
        digest: null, refersToUri: null, refersToDate: null,
        truncated: null, http: null, payload: null,
    };
};

const versionOf = (entries: WarcRecordEntries, key: string) => entries.treeVersions.get(key) ?? 0;

describe("running record totals", () => {
    test("counts every record, and responses separately", () => {
        const entries = createRecordEntries();

        pushRecord(record("https://a/1", "response"), entries);
        pushRecord(record("https://a/1", "request"), entries);
        pushRecord(record("https://a/2", "response"), entries);
        pushRecord(record("urn:pageinfo:https://a/", "resource"), entries);
        pushRecord(record("https://a/3", "revisit"), entries);

        // Everything is counted, including the urn: metadata that never reaches
        // the tree — `records` is the archive as parsed, not the browsable subset.
        expect(entries.recordCount).toBe(5);
        expect(entries.responseCount).toBe(2);

        // And they agree with the list they describe, which is the thing that would
        // silently drift if either increment were missed.
        expect(entries.recordCount).toBe(entries.records.length);
        expect(entries.responseCount)
            .toBe(entries.records.filter(one => one.type === "response").length);
    });

    test("a rejected duplicate moves neither count", () => {
        const entries = createRecordEntries();
        const one = record("https://a/1");

        expect(pushRecord(one, entries)).toBe(true);
        expect(pushRecord(one, entries)).toBe(false);

        expect(entries.recordCount).toBe(1);
        expect(entries.responseCount).toBe(1);
    });

    test("start at zero", () => {
        const entries = createRecordEntries();

        expect(entries.recordCount).toBe(0);
        expect(entries.responseCount).toBe(0);
    });
});

describe("the count wake", () => {
    // Without this the titlebar total is permanently stale, and nothing else on
    // screen would reveal it — the tree updates through its own per-node keys.
    test("every accepted record bumps RECORD_COUNT_KEY", () => {
        const entries = createRecordEntries();
        const seen: number[] = [];

        for (let i = 0; i < 4; i++) {
            pushRecord(record(`https://a/${i}`), entries);
            seen.push(versionOf(entries, RECORD_COUNT_KEY));
        }

        expect(seen).toEqual([1, 2, 3, 4]);
        // And it is in the dirty set, which is what the store's flush drains to
        // actually wake the listener.
        expect(entries.dirtyTreeUrls.has(RECORD_COUNT_KEY)).toBe(true);
    });

    test("a rejected duplicate does not bump it", () => {
        const entries = createRecordEntries();
        const one = record("https://a/1");

        pushRecord(one, entries);
        const after = versionOf(entries, RECORD_COUNT_KEY);

        pushRecord(one, entries);
        expect(versionOf(entries, RECORD_COUNT_KEY)).toBe(after);
    });

    // The count key has to be its own, not a shape key. A second capture of a url
    // already in the tree changes the total and not the shape, so a count watching
    // the shape would sit still while records poured in.
    test("a record on an existing node bumps the count but not the shape", () => {
        const entries = createRecordEntries();

        pushRecord(record("https://a/1"), entries);

        const shapeBefore = versionOf(entries, TREE_SHAPE_KEY);
        const countBefore = versionOf(entries, RECORD_COUNT_KEY);

        // Same url, new record — no new node anywhere.
        pushRecord(record("https://a/1"), entries);

        expect(versionOf(entries, RECORD_COUNT_KEY)).toBe(countBefore + 1);
        expect(versionOf(entries, TREE_SHAPE_KEY)).toBe(shapeBefore);
    });

    // Untreed records still count, so the key must be bumped by pushRecord itself
    // rather than by the tree insert it may skip.
    test("a urn: record counts even though it never enters the tree", () => {
        const entries = createRecordEntries();

        pushRecord(record("urn:pageinfo:https://a/", "resource"), entries);

        expect(entries.recordCount).toBe(1);
        expect(versionOf(entries, RECORD_COUNT_KEY)).toBe(1);
        expect(entries.recordTree.length).toBe(0);
    });
});

/*
 * Which tree a url lands in.
 *
 * Pinned because the two trees were merged onto ONE url parse — they used to call
 * `new URL` separately on the same string, which was two parses, two
 * URLSearchParams sorts and two path splits per record. The parse is shared now
 * and each tree projects its own root from it, so the routing rules are the thing
 * that could quietly change: the raw tree additionally refuses any scheme whose
 * `origin` is "null", which is what keeps `onion://` out of it and in the
 * normalized one.
 */
describe("tree routing", () => {
    const routeOf = (url: string, type: WarcRecord["type"] = "response") => {
        const entries = createRecordEntries();
        pushRecord(record(url, type), entries);

        return {
            raw: entries.recordTree.length,
            normal: entries.normalTree.length,
            untreed: entries.untreedRecords.length,
        };
    };

    test("an ordinary https url reaches both trees", () => {
        expect(routeOf("https://oacu.oir.nih.gov/about/")).toEqual({ raw: 1, normal: 1, untreed: 0 });
    });

    // A host but no origin. The whole reason the two trees disagree.
    test("onion: reaches the normalized tree only", () => {
        expect(routeOf("onion://abcd.onion/x")).toEqual({ raw: 0, normal: 1, untreed: 0 });
    });

    test("hostless and non-web schemes reach neither, and are kept", () => {
        for (const url of ["urn:pageinfo:https://a/", "dns:example.com", "data:text/html,hi", "about:blank"]) {
            expect(routeOf(url, "resource")).toEqual({ raw: 0, normal: 0, untreed: 1 });
        }
    });

    test("an unparseable url is kept, not dropped", () => {
        expect(routeOf(":::not a url:::", "metadata")).toEqual({ raw: 0, normal: 0, untreed: 1 });
    });

    // The shared parse hands both trees the SAME segments array. Safe only because
    // placeInTree iterates it and never mutates — if that ever changes, the second
    // tree would see a consumed array and this is what would catch it.
    test("both trees get the full path, not a consumed one", () => {
        const entries = createRecordEntries();
        pushRecord(record("https://a.example.com/one/two/three.html"), entries);

        // host + one + two + three.html
        const depth = (nodes: typeof entries.recordTree): number =>
            nodes.length === 0 ? 0 : 1 + Math.max(...nodes.map(node => depth(node.children)));

        expect(depth(entries.recordTree)).toBe(4);
        expect(depth(entries.normalTree)).toBe(4);
    });

    // Query sorting is what makes `?a=1&b=2` and `?b=2&a=1` one node. Shared
    // between the trees now, so it is worth asserting it survived the merge.
    test("a query is one node per canonical parameter set, in both trees", () => {
        const entries = createRecordEntries();

        pushRecord(record("https://f.com/t?id=1&b=2"), entries);
        pushRecord(record("https://f.com/t?b=2&id=1"), entries);

        const leaves = (nodes: typeof entries.recordTree): number =>
            nodes.reduce((total, node) => total + (node.children.length === 0 ? 1 : leaves(node.children)), 0);

        expect(leaves(entries.recordTree)).toBe(1);
        expect(leaves(entries.normalTree)).toBe(1);
    });
});
