// bun test components/Offline/parserBundle.test.ts
//
// The parser script url, which stopped being a promise.
//
// It used to be `getParserUrl(): Promise<string>` — fetch the bundle cross-origin,
// wrap it in a Blob, hand out an object url — so every worker in the app was
// `new Worker(await getParserUrl())`. A blob url gets neither the HTTP cache nor
// V8's code cache, so that was a fresh 190 KB compile per worker, and one worker
// per hardware thread meant two dozen cold compiles in a synchronous loop.
//
// What is worth pinning here is not the string but the SHAPE: synchronous, and
// same-origin, because `new Worker` rejects a cross-origin script outright and a
// relative path is the only thing that keeps the Blob from coming back.

import { beforeEach, describe, expect, test } from "bun:test";
import {
    PARSER_SCRIPT_URL,
    __resetParserBundle,
    parserBundleBuiltAt,
    parserScriptProblem,
    parserScriptUrl,
    warmParserScript,
} from "./parserBundle";

/** Swap in a fetch, and report what it was asked for. */
const stubFetch = (responder: (url: string) => Response | Promise<Response>) => {
    const asked: string[] = [];

    (globalThis as Record<string, unknown>).fetch = ((input: string) => {
        asked.push(String(input));
        return Promise.resolve(responder(String(input)));
    }) as unknown as typeof fetch;

    return asked;
};

const script = (headers: Record<string, string> = {}) =>
    new Response("self.onmessage = () => {};", {
        headers: { "content-type": "text/javascript; charset=utf-8", ...headers },
    });

beforeEach(() => {
    __resetParserBundle();
});

describe("parserScriptUrl", () => {
    test("is synchronous — a string, not a promise", () => {
        const url = parserScriptUrl();

        expect(typeof url).toBe("string");
        expect(url).toBe(PARSER_SCRIPT_URL);
    });

    // Cross-origin is a hard error in the Worker constructor, and a blob: url is
    // what the old code paid to avoid it. A relative path is what keeps it away.
    test("is same-origin and relative, never absolute", () => {
        expect(parserScriptUrl()).toStartWith("/");
        expect(parserScriptUrl()).not.toContain("://");
        expect(parserScriptUrl()).not.toContain("blob:");
    });

    test("is stable, so every worker shares one cache entry", () => {
        expect(parserScriptUrl()).toBe(parserScriptUrl());
    });
});

describe("warmParserScript", () => {
    test("fetches the same url the workers will use", async () => {
        const asked = stubFetch(() => script());

        await warmParserScript();

        expect(asked).toEqual([parserScriptUrl()]);
    });

    test("fetches once, however many times it is called", async () => {
        const asked = stubFetch(() => script());

        await Promise.all([warmParserScript(), warmParserScript()]);
        await warmParserScript();

        expect(asked).toHaveLength(1);
    });

    test("records the build time, for the stale-bundle report", async () => {
        stubFetch(() => script({ "x-parser-built-at": "2026-08-21T12:00:00.000Z" }));

        await warmParserScript();

        expect(parserBundleBuiltAt()).toBe("2026-08-21T12:00:00.000Z");
        expect(parserScriptProblem()).toBeNull();
    });

    /*
     * The checks that earned their place. Handing a 404 to `new Worker` produces
     * "Uncaught SyntaxError: Unexpected token '<'" from inside a worker, because
     * the HTML error page is what got compiled — and the real cause, a backend
     * that is not running, appears nowhere.
     */
    test("explains a 404 rather than leaving it to the Worker", async () => {
        stubFetch(() => new Response("nope", { status: 404, statusText: "Not Found" }));

        await warmParserScript();

        expect(parserScriptProblem()).toContain("404");
        expect(parserScriptProblem()).toContain("backend");
    });

    test("explains a 200 that is not JavaScript", async () => {
        stubFetch(() => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));

        await warmParserScript();

        expect(parserScriptProblem()).toContain("not JavaScript");
        // The likely cause named outright: Next answered instead of proxying.
        expect(parserScriptProblem()).toContain("rewritten to the backend");
    });

    test("explains a network failure", async () => {
        (globalThis as Record<string, unknown>).fetch = (() =>
            Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;

        await warmParserScript();

        expect(parserScriptProblem()).toContain("Failed to fetch");
    });

    // Speculative work on a page nobody asked to load: it must not throw into the
    // prewarm, which has no caller to report to.
    test("never rejects", async () => {
        (globalThis as Record<string, unknown>).fetch = (() =>
            Promise.reject(new Error("boom"))) as unknown as typeof fetch;

        expect(await warmParserScript().then(() => "resolved", () => "rejected")).toBe("resolved");
    });

    test("a clean fetch leaves no problem behind", async () => {
        stubFetch(() => script());

        await warmParserScript();

        expect(parserScriptProblem()).toBeNull();
    });
});
