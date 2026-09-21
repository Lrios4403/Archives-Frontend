// bun test components/WebMCP/offlineTools.test.ts
//
// The data-access patterns the offline WebMCP tools depend on.
//
// The tools themselves live inside React context and cannot be executed without
// a browser, a loaded archive and WebMCP enabled — so what is pinned here is the
// layer underneath: that the archive's own indexes answer the questions the
// tools ask of them, against records built the same way the parser builds them.
//
// Each test mirrors one tool's lookup exactly. If one of these breaks, that tool
// is returning something wrong to an agent, silently, with no UI to notice it.

import { describe, expect, test } from "bun:test";
import { createRecordEntries, pushRecord } from "../Offline/records";
import { findNearestRecord } from "../Offline/view";
import type { WarcFileHande, WarcRecord, WarcRecordEntries, WarcRecordTreeNode } from "../Offline/types";

const handle = {
    name: "t.warc.gz", size: 1, parsedOffset: 0,
    file: new File([new Uint8Array(1)], "t.warc.gz"),
} as WarcFileHande;

let unique = 0;

const record = (
    url: string,
    archived: string,
    contentType = "text/html",
    type: WarcRecord["type"] = "response",
): WarcRecord => {
    const uuid = `u${unique++}`;
    const dateArchived = new Date(archived);

    return {
        uuid, url, dateArchived, lastArchived: dateArchived,
        contentType, fileHandle: handle,
        customId: `${handle.name}::${url}::${uuid}`,
        type, offset: 0, length: 0,
        ip: null, concurrentTo: null, refersTo: null,
        digest: null, refersToUri: null, refersToDate: null,
        truncated: null, http: null,
        /*
         * A payload is REQUIRED for a record to be a candidate.
         *
         * nearestCapture in view.ts keeps a response only if it has one, or
         * if it is a redirect — a capture with no body is not something the
         * viewer can show, and it reports `no-payload` rather than handing
         * back an empty page. Records built without this looked fine and
         * made every as-of lookup miss.
         */
        payload: { offset: 0, size: 1, digest: null },
    };
};

/** A small archive with two hosts, repeat captures, and one non-response. */
const archive = (): WarcRecordEntries => {
    const entries = createRecordEntries();

    [
        record("https://example.com/", "2017-03-01"),
        record("https://example.com/", "2018-06-01"),
        record("https://example.com/", "2021-09-01"),
        record("https://example.com/navi/rose/garden.html", "2018-06-01"),
        record("https://example.com/logo.png", "2018-06-01", "image/png"),
        record("https://other.test/index.html", "2020-01-01"),
        // A request record: held, but never browsable.
        record("https://example.com/", "2018-06-01", "text/html", "request"),
    ].forEach((r) => pushRecord(r, entries));

    return entries;
};

const isBrowsable = (r: WarcRecord): boolean => r.type === "response" && Boolean(r.url);

describe("describe_loaded_archive", () => {
    test("counts responses separately from everything held", () => {
        const entries = archive();

        expect(entries.recordCount).toBe(7);
        // The request is held and is not a capture anyone can browse.
        expect(entries.responseCount).toBe(6);
    });

    test("groups captures by host, ignoring non-responses", () => {
        const entries = archive();
        const hosts = new Map<string, number>();

        entries.records.filter(isBrowsable).forEach((r) => {
            const host = new URL(r.url).host;

            hosts.set(host, (hosts.get(host) ?? 0) + 1);
        });

        expect(hosts.get("example.com")).toBe(5);
        expect(hosts.get("other.test")).toBe(1);
    });
});

describe("search_loaded_records", () => {
    test("the segment index finds a page by one path segment", () => {
        const entries = archive();
        const hits = new Set<WarcRecordTreeNode>();

        // Exactly what the tool does: walk the DISTINCT segments, not the tree.
        entries.segments.forEach((nodes, segment) => {
            if (segment.toLowerCase().includes("garden")) nodes.forEach((n) => hits.add(n));
        });

        const urls = [...hits].flatMap((n) => n.records.filter(isBrowsable)).map((r) => r.url);

        expect(urls).toContain("https://example.com/navi/rose/garden.html");
    });

    test("falls back to whole-url matching for a query spanning segments", () => {
        const entries = archive();
        const needle = "example.com/navi";
        const bySegment = new Set<WarcRecordTreeNode>();

        entries.segments.forEach((nodes, segment) => {
            if (segment.toLowerCase().includes(needle)) nodes.forEach((n) => bySegment.add(n));
        });

        // No single segment contains "example.com/navi" — that is the case the
        // fallback exists for, and without it the tool would report "not found"
        // for a perfectly ordinary query.
        expect(bySegment.size).toBe(0);

        const byUrl = [...entries.recordsUrlMap.keys()].filter((u) => u.toLowerCase().includes(needle));

        expect(byUrl).toContain("https://example.com/navi/rose/garden.html");
    });

    test("filters by the normalised base content type", () => {
        const entries = archive();
        const images = entries.records.filter(isBrowsable).filter((r) => r.contentType === "image/png");

        expect(images).toHaveLength(1);
        expect(images[0].url).toBe("https://example.com/logo.png");
    });
});

describe("get_loaded_timeline", () => {
    test("returns every capture of one url, and only that url", () => {
        const entries = archive();
        const recs = (entries.recordsUrlMap.get("https://example.com/") ?? []).filter(isBrowsable);

        expect(recs).toHaveLength(3);

        const dates = [...recs]
            .sort((a, b) => b.dateArchived.getTime() - a.dateArchived.getTime())
            .map((r) => r.dateArchived.toISOString().slice(0, 10));

        expect(dates).toEqual(["2021-09-01", "2018-06-01", "2017-03-01"]);
    });

    test("scheme matters, which is why the tool says so", () => {
        const entries = archive();

        expect(entries.recordsUrlMap.get("http://example.com/")).toBeUndefined();
    });
});

describe("find_loaded_capture_as_of", () => {
    test("picks the capture nearest the date asked for", () => {
        const entries = archive();
        const at = (iso: string) =>
            findNearestRecord(entries, "https://example.com/", new Date(iso).toISOString(), {
                stopAtBodiedRedirect: true,
            }).record?.dateArchived.toISOString().slice(0, 10);

        expect(at("2017-01-01")).toBe("2017-03-01");
        expect(at("2018-05-01")).toBe("2018-06-01");
        expect(at("2026-01-01")).toBe("2021-09-01");
    });

    test("reports a miss rather than inventing a capture", () => {
        const entries = archive();
        const result = findNearestRecord(
            entries,
            "https://nothing.invalid/",
            new Date("2020-01-01").toISOString(),
        );

        expect(result.record).toBeNull();
        expect(result.reason).toBeDefined();
    });
});
