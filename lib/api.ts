/*
 * Where the archives backend lives — in one place.
 *
 * This existed as `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000"`
 * copy-pasted into four files (lib/db.tsx, next.config.mjs, the view page and
 * the offline page). Four copies of a default is four chances for one of them
 * to be missed, and the failure is quiet: the build succeeds, the page renders,
 * and one fetch goes to a machine that is not serving the archive.
 *
 * ## Why there are TWO urls and not one
 *
 * They answer different questions, and a single variable can only be right for
 * one of them once the backend stops being on this machine:
 *
 *   INTERNAL — the address the NEXT SERVER dials. Server Components in
 *   lib/db.tsx and the rewrite destinations in next.config.mjs use it. It never
 *   reaches a browser, so it is free to be a tunnel endpoint, a private address,
 *   or a docker service name.
 *
 *   PUBLIC — the address a BROWSER dials. Exactly one thing needs it: the
 *   viewer iframe's src (components/WarcView/Viewer.tsx). That request is made
 *   by the reader's browser, so it has to be reachable from there, and it is
 *   deliberately cross-origin — the origin check on the `warc-navigate`
 *   postMessage is only meaningful because the archived page sits on a
 *   different origin from the app around it. Routing it through a same-origin
 *   rewrite would quietly destroy that boundary.
 *
 * Everything else the browser calls (/api/warcs/near, /api/warcs/download,
 * /api/warcs/parser/*) is deliberately RELATIVE and travels through the
 * rewrites in next.config.mjs. Those need no base url at all, which is why they
 * do not appear here.
 *
 * ## The wireguard case
 *
 * The plan is to tunnel localhost:3000/api/warcs/* to
 * archives.m4cgyver.net/api/warcs/*. With the tunnel on this machine, BOTH urls
 * stay http://localhost:3000 and nothing here changes — the tunnel is
 * transparent. The split matters the moment the frontend runs somewhere the
 * tunnel does not: then INTERNAL keeps pointing at the tunnel and PUBLIC
 * becomes https://archives.m4cgyver.net, and no code has to move.
 */

/** Used when nothing is configured: the backend as it runs under compose. */
const DEFAULT_API_URL = "http://localhost:3000";

/**
 * Browser-facing origin of the backend.
 *
 * NEXT_PUBLIC_ so Next inlines it into the client bundle. That prefix is not
 * decoration — a variable without it is simply absent in the browser, and this
 * value is read on the client.
 */
export const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;

/**
 * Server-side origin of the backend.
 *
 * Falls back to the public url so a single-machine setup only has to configure
 * one variable — which is the common case and the one that should not require
 * reading this file.
 *
 * Deliberately safe to import from a client component: `API_INTERNAL_URL` has
 * no NEXT_PUBLIC_ prefix, so on the client it evaluates to undefined and this
 * degrades to PUBLIC_API_URL rather than producing `undefined/api/warcs/...`.
 */
export const INTERNAL_API_URL =
  process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;
