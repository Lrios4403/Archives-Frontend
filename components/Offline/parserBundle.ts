'use client';

/**
 * Where the parse workers get their code.
 *
 * The bundle is built and cached by the BACKEND (see backend/routes/parser.tsx),
 * not by Next — the parser is Bun-side source shared with the server, and one
 * build of it is the only way the two cannot disagree.
 *
 * ## Why this is a plain string now
 *
 * It used to be `getParserUrl(): Promise<string>`: fetch the bundle cross-origin,
 * read it into a Blob, hand out `URL.createObjectURL(blob)`. Every worker was
 * therefore `new Worker(await getParserUrl())`, and that shape cost more than the
 * await it forced on three call sites:
 *
 *   - A blob-URL script cannot be served from the HTTP cache and — the expensive
 *     part — gets no V8 code cache. Every `new Worker` recompiled 190 KB from
 *     scratch, every time, on every page load. Spawning one per hardware thread
 *     (24 on this machine, since the cap came off) meant 24 cold compiles in a
 *     synchronous loop, which is the stutter.
 *   - The bytes were held twice: once as a Blob for the life of the tab, and
 *     again inside every worker.
 *   - Nothing could start until the fetch resolved, so the first parse of a
 *     session waited on the network for code it was about to run locally.
 *
 * A same-origin URL fixes all three at once, and same-origin is what
 * `new Worker(url)` requires — a cross-origin script is a hard error, which is
 * why the Blob was there in the first place. next.config.mjs rewrites this path
 * to the backend, so the browser sees one origin and the bundle still comes from
 * the one place that builds it. With a real URL the browser caches the script and
 * its compiled form, and the second worker onwards starts from that.
 *
 * The route sends `Cache-Control: no-cache`, so each construction still
 * revalidates — a conditional request that answers 304 with no body, which is
 * what keeps a source edit from being invisible in development.
 */

/**
 * Same-origin, and a rewrite target rather than a real Next route.
 *
 * Deliberately the same path the backend serves it on, so the two are searchable
 * as one string and a misconfigured rewrite fails as a 404 on a path that exists
 * upstream — the one shape warmParserScript can explain.
 */
export const PARSER_SCRIPT_URL = '/api/warcs/parser/index.js';

/** The worker script. Synchronous, which is the whole point. */
export const parserScriptUrl = (): string => PARSER_SCRIPT_URL;

/**
 * When the bundle we are running was built, from the X-Parser-Built-At header.
 *
 * Captured for one reason: to put a timestamp in the stale-bundle error. "The
 * worker sent an unknown action" tells you something is out of date; "the bundle
 * you are running was built 4 hours ago" tells you it is the backend, and stops
 * the next person re-reading this file looking for the bug.
 */
let parserBuiltAt: string | null = null;

/**
 * Why the script would not load, in a sentence, or null if it looked fine.
 *
 * The old fetch checked the status and the content-type before ever handing bytes
 * to a Worker, and those checks earned their place: a 404 became an HTML error
 * page wrapped in a blob URL, and the browser reported it as "Uncaught
 * SyntaxError: Unexpected token '<'" from inside a worker, with the real cause —
 * wrong host, backend down, rewrite missing — nowhere on screen.
 *
 * Handing the URL straight to `new Worker` gives that up, so the check moved
 * here: made once, off the critical path, and read back by the error handlers
 * that would otherwise have nothing but "the worker stopped".
 */
let parserProblem: string | null = null;

let warming: Promise<void> | null = null;

/**
 * Fetch the script once: prime the cache, and find out whether it is even there.
 *
 * Called from the idle prewarm, never from a path a reader is waiting on. Two
 * jobs, and the first is the reason this is a GET of the whole body rather than a
 * HEAD: it puts the bytes in the HTTP cache under the exact URL the workers will
 * ask for, so the first `new Worker` does not go to the network at all.
 *
 * Never rejects. A problem here is recorded, not thrown — the parse or view that
 * actually needs the worker is where a reader can be told about it.
 */
export const warmParserScript = (): Promise<void> => {
    if (warming) return warming;

    warming = fetch(PARSER_SCRIPT_URL)
        .then(async response => {
            if (!response.ok) {
                parserProblem =
                    `The parser bundle could not be fetched: ${response.status} ${response.statusText} ` +
                    `from ${PARSER_SCRIPT_URL}. Is the backend running, and is the rewrite in ` +
                    `next.config.mjs pointing at it?`;
                return;
            }

            const contentType = response.headers.get('content-type') ?? '';

            if (!contentType.includes('javascript')) {
                parserProblem =
                    `The parser bundle is not JavaScript (content-type: ${contentType || 'none'}). ` +
                    `${PARSER_SCRIPT_URL} is probably being answered by Next itself rather than ` +
                    `rewritten to the backend.`;
                return;
            }

            parserBuiltAt = response.headers.get('x-parser-built-at');
            parserProblem = null;

            // Drained on purpose. An unread body is not stored, and storing it is
            // the point: this is what makes the workers' own requests cache hits.
            await response.arrayBuffer();
        })
        .catch(error => {
            parserProblem =
                `The parser bundle could not be fetched from ${PARSER_SCRIPT_URL}: ` +
                `${error instanceof Error ? error.message : String(error)}`;
        });

    return warming;
};

/** When the bundle we are running was built, per X-Parser-Built-At. Null if unknown. */
export const parserBundleBuiltAt = () => parserBuiltAt;

/**
 * Why a worker would have failed to start, if we know. Null otherwise.
 *
 * Null also means "not checked yet" — the warm-up is speculative and may not have
 * run. Callers treat it as extra detail when it is there, never as the verdict.
 */
export const parserScriptProblem = () => parserProblem;

/** Test seam: the module caches its one fetch for the life of the page. */
export const __resetParserBundle = (): void => {
    warming = null;
    parserBuiltAt = null;
    parserProblem = null;
};
