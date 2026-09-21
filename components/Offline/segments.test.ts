// bun test components/Offline/segments.test.ts
//
// Planning segments, and summing their progress into one bar.
//
// The arithmetic is the trap. A worker whose share starts at 1.2 GB has parsed
// NOTHING at 1.2 GB, so the file's figure is Σ (at − start), not Σ at. Summing raw
// positions would open a segmented 1.6 GB file at about 75% before any work
// happened, and it would look plausible.

import { describe, expect, test } from "bun:test";
import { maxSegmentsFor, planTasks, usefulWorkers } from "./workers";
import { applyProgress, watchProgress } from "./progress";
import type { WarcFileHande } from "./types";

const handleOf = (name: string, size: number): WarcFileHande => ({
    name,
    size,
    parsedOffset: 0,
    file: { size } as Blob,
} as WarcFileHande);

const MB = 1024 * 1024;

/*
 * How many workers the form asks for.
 *
 * This is where the whole feature was silently dead: the form computed
 * `min(workers, files.length)`, so ONE big file meant ONE worker, planTasks was
 * handed `workers = 1`, and it returned a whole-file task. Every lower-level test
 * passed — the parser was correct, the progress arithmetic was correct — and nothing
 * was ever segmented in the running app.
 *
 * So the count has to be derived from SEGMENTS, and these are the tests that would
 * have caught it.
 */
describe("usefulWorkers", () => {
    test("one big file can occupy several threads", () => {
        const handle = handleOf("big.warc", 1600 * MB);

        expect(usefulWorkers([handle], 4)).toBe(4);
        expect(usefulWorkers([handle], 24)).toBe(24);
    });

    test("one small file is still one thread", () => {
        expect(usefulWorkers([handleOf("small.warc", 40 * MB)], 4)).toBe(1);
    });

    test("a compressed file is one thread however big it is", () => {
        expect(usefulWorkers([handleOf("big.warc.gz", 1600 * MB)], 8)).toBe(1);
        expect(usefulWorkers([handleOf("big.wacz", 1600 * MB)], 8)).toBe(1);
    });

    test("the request is still the ceiling", () => {
        expect(usefulWorkers([handleOf("big.warc", 1600 * MB)], 2)).toBe(2);
        expect(usefulWorkers([handleOf("big.warc", 1600 * MB)], 1)).toBe(1);
    });

    test("it is capped by what the file can actually be cut into", () => {
        // 200 MB / 64 MB = 3 blocks, so a 24-thread request yields 3.
        expect(usefulWorkers([handleOf("mid.warc", 200 * MB)], 24)).toBe(3);
    });

    test("several files add up", () => {
        const files = [
            handleOf("a.warc", 40 * MB),      // 1
            handleOf("b.warc", 200 * MB),     // 3
            handleOf("c.warc.gz", 900 * MB),  // 1
        ];

        expect(usefulWorkers(files, 24)).toBe(5);
    });

    test("no files still asks for one", () => {
        expect(usefulWorkers([], 8)).toBe(1);
    });

    /*
     * The two must agree, or the form starves planTasks exactly as it did before.
     *
     * "Agree" means both land on `min(requested, maxSegmentsFor)` — NOT on
     * `maxSegmentsFor` itself. A 1600 MB file is 25 blocks of 64 MB, so at 24
     * threads planTasks correctly makes 24 segments, not 25. The first version of
     * this test asserted the wrong thing and failed against correct code.
     */
    test("agrees with planTasks about how many threads a file can use", () => {
        const handles = [
            handleOf("big.warc", 1600 * MB),
            handleOf("mid.warc", 200 * MB),
            handleOf("small.warc", 40 * MB),
            handleOf("z.warc.gz", 1600 * MB),
        ];

        for (const requested of [1, 2, 4, 24, 64]) {
            for (const handle of handles) {
                const want = Math.min(requested, maxSegmentsFor(handle));

                expect(planTasks(handle, requested).length).toBe(want);
                expect(usefulWorkers([handle], requested)).toBe(want);
            }
        }
    });
});

describe("planTasks", () => {
    test("a small file is one whole-file task", () => {
        const tasks = planTasks(handleOf("small.warc", 40 * MB), 4);

        expect(tasks.length).toBe(1);
        expect(tasks[0]!.segment).toBeUndefined();
    });

    // One worker means one task no matter how big the file is.
    test("one worker is never segmented", () => {
        const tasks = planTasks(handleOf("big.warc", 1600 * MB), 1);

        expect(tasks.length).toBe(1);
        expect(tasks[0]!.segment).toBeUndefined();
    });

    test("a big file is split, and the ranges abut exactly", () => {
        const size = 1600 * MB;
        const handle = handleOf("big.warc", size);
        const tasks = planTasks(handle, 4);

        expect(tasks.length).toBe(4);

        // No gap and no overlap. A record starting in a crack between two segments
        // would belong to nobody, and the parse would silently lose it.
        expect(tasks[0]!.segment!.start).toBe(0);
        expect(tasks.at(-1)!.segment!.end).toBe(size);

        for (let i = 1; i < tasks.length; i++) {
            expect(tasks[i]!.segment!.start).toBe(tasks[i - 1]!.segment!.end);
        }

        // Indices are what progress messages are attributed by.
        expect(tasks.map(task => task.segment!.index)).toEqual([0, 1, 2, 3]);
        expect(tasks.every(task => task.segment!.count === 4)).toBe(true);
    });

    // The floor is set by the largest RECORD, not the read chunk. A 100 MB file on
    // 4 workers gets one segment, not four 25 MB ones a single record could span.
    test("segment count is capped by the 64 MB floor, not by the worker count", () => {
        expect(planTasks(handleOf("a.warc", 200 * MB), 8).length).toBe(3);
        expect(planTasks(handleOf("b.warc", 100 * MB), 8).length).toBe(1);
        expect(planTasks(handleOf("c.warc", 640 * MB), 4).length).toBe(4);
    });

    // Byte segmentation is meaningless inside a DEFLATE stream — see
    // segments.plan.md §8. A .wacz is already one handle per archive, so it loses
    // nothing by being excluded here.
    test("compressed and container files are never segmented", () => {
        for (const name of ["a.warc.gz", "b.wacz", "c.wacz.zip", "d.zip"]) {
            const tasks = planTasks(handleOf(name, 1600 * MB), 4);

            expect(tasks.length).toBe(1);
            expect(tasks[0]!.segment).toBeUndefined();
        }
    });

    test("planning seeds the progress slots to match the ranges", () => {
        const handle = handleOf("big.warc", 1600 * MB);
        const tasks = planTasks(handle, 4);

        expect(handle.segments?.length).toBe(4);

        handle.segments!.forEach((slot, i) => {
            expect(slot.start).toBe(tasks[i]!.segment!.start);
            expect(slot.end).toBe(tasks[i]!.segment!.end);
            // Nothing done yet, which is what makes the initial sum zero.
            expect(slot.at).toBe(slot.start);
            expect(slot.done).toBe(false);
        });
    });
});

describe("segmented progress", () => {
    const started = () => {
        const handle = handleOf("big.warc", 1600 * MB);
        planTasks(handle, 4);
        return handle;
    };

    const report = (handle: WarcFileHande, segment: number, at: number, done = false) =>
        applyProgress(handle, {
            offset: 0,
            size: handle.size!,
            status: done ? "parsed" : "parsing",
            segment,
            segmentAt: at,
        });

    // THE test. Four workers each sitting at their own start have parsed nothing.
    test("a freshly started segmented file reads zero, not 75%", () => {
        const handle = started();

        for (const [i, slot] of handle.segments!.entries()) report(handle, i, slot.start);

        expect(handle.parsedOffset).toBe(0);
    });

    test("the file's figure is the sum of what each segment finished", () => {
        const handle = started();
        const slots = handle.segments!;

        report(handle, 0, slots[0]!.start + 10 * MB);
        report(handle, 2, slots[2]!.start + 30 * MB);

        expect(handle.parsedOffset).toBe(40 * MB);
    });

    test("it reaches exactly the file size when every segment finishes", () => {
        const handle = started();

        // Out of order on purpose: workers do not finish in index order.
        for (const i of [2, 0, 3, 1]) report(handle, i, handle.segments![i]!.end, true);

        expect(handle.parsedOffset).toBe(handle.size);
        expect(handle.segments!.every(slot => slot.done)).toBe(true);
    });

    test("progress never walks backwards, even out of order", () => {
        const handle = started();
        const slots = handle.segments!;
        let previous = 0;

        const steps: [number, number][] = [
            [0, 20 * MB], [3, 100 * MB], [1, 5 * MB], [0, 40 * MB],
            [2, 200 * MB], [3, 150 * MB], [1, 60 * MB],
        ];

        for (const [index, delta] of steps) {
            report(handle, index, slots[index]!.start + delta);

            expect(handle.parsedOffset).toBeGreaterThanOrEqual(previous);
            expect(handle.parsedOffset).toBeLessThanOrEqual(handle.size!);
            previous = handle.parsedOffset;
        }
    });

    // A late message from a slower path must not pull a segment back.
    test("a stale, lower report is ignored", () => {
        const handle = started();

        report(handle, 1, handle.segments![1]!.start + 50 * MB);
        const high = handle.parsedOffset;

        report(handle, 1, handle.segments![1]!.start + 10 * MB);

        expect(handle.parsedOffset).toBe(high);
    });

    // A worker cannot claim more than its share, however it is reported.
    test("a segment is clamped to its own end", () => {
        const handle = started();

        report(handle, 0, handle.size! * 2);

        expect(handle.parsedOffset).toBe(handle.segments![0]!.end);
    });

    /*
     * A stale message from a previous parse of this handle.
     *
     * It must leave the total ALONE. The first version of the fold returned null
     * here and applyProgress fell through to `progress.offset` — so an
     * unattributable segment report overwrote the sum with one worker's raw
     * position, which is not the file's progress by any reading.
     */
    test("a report for an unknown segment is ignored", () => {
        const handle = started();

        reportCounts(handle, 0, handle.segments![0]!.start + 8 * MB, 42, 21);
        const before = handle.parsedOffset;

        reportCounts(handle, 99, 999 * MB, 9_999, 9_999);

        expect(handle.parsedOffset).toBe(before);
        expect(handle.records).toBe(42);
        expect(handle.responses).toBe(21);
    });

    /*
     * Work stealing, as the `resegmented` handler performs it.
     *
     * Replicated here rather than driven through a real worker because the thing
     * worth testing is the ARITHMETIC — that the donor shrinks by exactly what the
     * taker gains, so the sum still lands on the file size. Driving it through a
     * Worker would test postMessage.
     */
    const steal = (handle: WarcFileHande, index: number, stoppedAt: number) => {
        const segments = handle.segments!;
        const slot = segments[index]!;

        if (stoppedAt >= slot.end) return null;

        const tailEnd = slot.end;
        slot.end = stoppedAt;
        slot.at = Math.min(slot.at, stoppedAt);

        segments.push({ start: stoppedAt, end: tailEnd, at: stoppedAt, done: false, records: 0, responses: 0 });

        return { index: segments.length - 1, start: stoppedAt, end: tailEnd };
    };

    test("a steal moves work without changing the total to be done", () => {
        const handle = started();
        const before = handle.segments!.reduce((sum, s) => sum + (s.end - s.start), 0);

        report(handle, 1, handle.segments![1]!.start + 100 * MB);
        const tail = steal(handle, 1, handle.segments![1]!.start + 100 * MB);

        expect(tail).not.toBeNull();

        const after = handle.segments!.reduce((sum, s) => sum + (s.end - s.start), 0);

        // The donor lost exactly what the tail gained, so the file is still the same
        // number of bytes of work. Getting this wrong double-counts the tail and the
        // bar sails past 100%.
        expect(after).toBe(before);
    });

    test("a stolen file still reaches exactly 100%", () => {
        const handle = started();

        report(handle, 1, handle.segments![1]!.start + 100 * MB);
        steal(handle, 1, handle.segments![1]!.start + 100 * MB);

        for (const [i, slot] of handle.segments!.entries()) report(handle, i, slot.end, true);

        expect(handle.parsedOffset).toBe(handle.size);
    });

    /*
     * THE race, and the reason `resegmented` is an answer rather than an
     * acknowledgement.
     *
     * The main thread picks a cut point from a progress figure that is already a
     * frame old. By the time the worker sees it, it may have parsed well past it. If
     * the tail were queued from the REQUESTED offset, everything between that and
     * where the worker actually stopped would be parsed twice.
     */
    test("the tail starts where the worker actually stopped, not where we asked", () => {
        const handle = started();
        const slot = handle.segments![1]!;

        const requested = slot.start + 100 * MB;
        // The worker was already further on when the request landed.
        const actual = slot.start + 140 * MB;

        const tail = steal(handle, 1, actual);

        expect(tail!.start).toBe(actual);
        expect(tail!.start).not.toBe(requested);
        // No overlap: the donor ends exactly where the tail begins.
        expect(handle.segments![1]!.end).toBe(tail!.start);
    });

    // The worker may finish its whole segment before the request arrives.
    test("a steal is dropped when the worker is already past the segment's end", () => {
        const handle = started();
        const slot = handle.segments![2]!;
        const count = handle.segments!.length;

        expect(steal(handle, 2, slot.end)).toBeNull();
        expect(steal(handle, 2, slot.end + 1)).toBeNull();
        expect(handle.segments!.length).toBe(count);
    });

    test("a stolen tail can itself be stolen from", () => {
        const handle = started();
        const first = handle.segments![3]!;

        const tail = steal(handle, 3, first.start + 100 * MB)!;
        const again = steal(handle, tail.index, tail.start + 50 * MB);

        expect(again).not.toBeNull();
        expect(handle.segments!.length).toBe(6);

        const total = handle.segments!.reduce((sum, s) => sum + (s.end - s.start), 0);
        expect(total).toBe(handle.size);
    });

    /*
     * Record counts, which were the visible symptom.
     *
     * Each worker's counters are per parseStream call — they start at zero and count
     * only that segment's share. The handle used to ASSIGN them, so a 25-segment
     * parse showed whichever segment reported last: a 1.6 GB archive holding 28,000
     * records displayed "865 responses of 1,729 records" and called itself complete,
     * while the tree held all of them.
     */
    const reportCounts = (
        handle: WarcFileHande,
        segment: number,
        at: number,
        records: number,
        responses: number,
        done = false,
    ) =>
        applyProgress(handle, {
            offset: 0,
            size: handle.size!,
            status: done ? "parsed" : "parsing",
            segment,
            segmentAt: at,
            records,
            responses,
        });

    test("record counts are summed across segments, not overwritten", () => {
        const handle = started();
        const slots = handle.segments!;

        reportCounts(handle, 0, slots[0]!.start + 10 * MB, 1_729, 865);
        expect(handle.records).toBe(1_729);

        reportCounts(handle, 1, slots[1]!.start + 10 * MB, 7_000, 3_500);
        reportCounts(handle, 2, slots[2]!.start + 10 * MB, 9_000, 4_500);
        reportCounts(handle, 3, slots[3]!.start + 10 * MB, 10_271, 5_135);

        // The whole file, not the last segment to speak.
        expect(handle.records).toBe(28_000);
        expect(handle.responses).toBe(14_000);
    });

    test("a later report for one segment replaces only that segment's count", () => {
        const handle = started();
        const slots = handle.segments!;

        reportCounts(handle, 0, slots[0]!.start + 10 * MB, 500, 250);
        reportCounts(handle, 1, slots[1]!.start + 10 * MB, 500, 250);
        expect(handle.records).toBe(1_000);

        // Segment 0 has found more since. Its own figure rises; the other stands.
        reportCounts(handle, 0, slots[0]!.start + 20 * MB, 900, 450);

        expect(handle.records).toBe(1_400);
        expect(handle.responses).toBe(700);
    });

    test("a stale, lower count is ignored", () => {
        const handle = started();

        reportCounts(handle, 0, handle.segments![0]!.start + 10 * MB, 900, 450);
        reportCounts(handle, 0, handle.segments![0]!.start + 10 * MB, 100, 50);

        expect(handle.records).toBe(900);
        expect(handle.responses).toBe(450);
    });

    test("a stolen tail's counts join the sum", () => {
        const handle = started();
        const slots = handle.segments!;

        reportCounts(handle, 1, slots[1]!.start + 100 * MB, 4_000, 2_000);
        const tail = steal(handle, 1, slots[1]!.start + 100 * MB)!;

        reportCounts(handle, tail.index, tail.start + 20 * MB, 1_500, 750);

        expect(handle.records).toBe(5_500);
        expect(handle.responses).toBe(2_750);
    });

    /*
     * What the LISTING actually receives.
     *
     * Every test above checks `handle.*`, and every one of them passed while the
     * bar was visibly broken — because the row does not read the handle. It reads
     * the report object handed to its progress callback (`update.offset`,
     * `update.records`), and for a segmented parse that object carried one worker's
     * figures. The bar jumped between four unrelated positions in the file and the
     * count showed a quarter of the records.
     *
     * So these assert the delivered REPORT, which is the thing with the bug.
     */
    const delivered = (handle: WarcFileHande) => {
        const seen: { offset: number; records?: number; responses?: number }[] = [];

        // Terminal reports bypass the frame coalescing, so 'parsed' arrives
        // synchronously and is what these read.
        watchProgress(handle, update => {
            seen.push({ offset: update.offset, records: update.records, responses: update.responses });
        });

        return seen;
    };

    test("the delivered report describes the file, not the segment", () => {
        const handle = started();
        const seen = delivered(handle);
        const slots = handle.segments!;

        /*
         * The LAST two segments, deliberately.
         *
         * For a prefix of the segments the sum of their spans happens to equal the
         * last one's absolute end — segments abut from zero, so the two numbers
         * coincide and the test cannot tell the right answer from the wrong one.
         * (Written that way first, and it failed against correct code.) Segments 2
         * and 3 sum to half the file while segment 3 ends AT the file size, so only
         * the correct figure passes.
         */
        reportCounts(handle, 2, slots[2]!.end, 1_729, 865, true);
        reportCounts(handle, 3, slots[3]!.end, 9_000, 4_500, true);

        expect(seen.length).toBe(2);

        // Not 1,729 — the whole file so far.
        expect(seen[1]!.records).toBe(10_729);
        expect(seen[1]!.responses).toBe(5_365);

        // The SUM of what those two finished, not segment 3's absolute end — which
        // is the file size, and would have drawn a full bar with half the file
        // unparsed.
        const expected = (slots[2]!.end - slots[2]!.start) + (slots[3]!.end - slots[3]!.start);

        expect(seen[1]!.offset).toBe(expected);
        expect(seen[1]!.offset).not.toBe(slots[3]!.end);
        expect(seen[1]!.offset).toBeLessThan(handle.size!);
    });

    test("the delivered offset never exceeds the file size", () => {
        const handle = started();
        const seen = delivered(handle);

        for (const [i, slot] of handle.segments!.entries()) {
            reportCounts(handle, i, slot.end, 1_000, 500, true);
        }

        expect(seen.every(one => one.offset <= handle.size!)).toBe(true);
        expect(seen.at(-1)!.offset).toBe(handle.size);
    });

    // The unsegmented path has to behave exactly as it did before any of this.
    test("without segments, offset is taken at face value", () => {
        const handle = handleOf("plain.warc", 100 * MB);

        applyProgress(handle, { offset: 25 * MB, size: 100 * MB, status: "parsing" });

        expect(handle.parsedOffset).toBe(25 * MB);
        expect(handle.segments).toBeUndefined();
    });
});
