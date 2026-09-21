// Data-access helpers for M4cgyvers Archives.
//
// NOTE: intentionally NOT "use server". These are plain data-fetching functions
// called by Server Components during render. Marking the module "use server"
// turns every export into a Server Action, which Next.js forbids calling during
// initial render ("Server Functions cannot be called during initial render").

import { unstable_rethrow } from "next/navigation"
import { cacheLife, cacheTag } from "next/cache"
import { readSnapshot, writeSnapshot } from "./snapshot"
import { INTERNAL_API_URL } from "./api"

/*
 * Every fetch in this file runs on the SERVER, so it takes the internal url.
 *
 * Server-side fetches need an absolute base — a relative path has no origin to
 * resolve against outside a browser. The internal one specifically, because
 * nothing here is ever executed by a reader's browser: see lib/api.ts for why
 * that distinction is worth two variables.
 */
const API_BASE_URL = INTERNAL_API_URL

/**
 * Every catch block below starts with unstable_rethrow(error), and it is not
 * optional.
 *
 * Next uses thrown values as control flow, and with Cache Components it aborts
 * the static prerender the moment it reaches a Suspense boundary whose content
 * needs request-time data. Any fetch() still in flight at that point is
 * rejected with a sentinel error (digest "HANGING_PROMISE_REJECTION") that means
 * "stop, this work belongs to the request, not the build". React swallows it
 * normally — but a .catch() of our own intercepts it first, and then we log a
 * scary "During prerendering, fetch() rejects when the prerender is complete"
 * for every streamed hole on every build, and worse, resolve the hole to our
 * empty-state fallback as if the backend had failed.
 *
 * unstable_rethrow re-throws that sentinel (plus redirect(), notFound(),
 * postpone and bailout-to-CSR signals) and returns normally for real errors, so
 * the handler below only ever sees an actual failure.
 */

export interface WarcRecord {
  recordId: string
  warcRecordId: string
  lastModified: string
  dateArchived: string
  status: number
  size: number // bytes
}

export interface WarcLatestResponse {
  response_id: number
  status: number
  headers: Record<string, unknown>
  http_version: string
  last_modified: string | null
  archived_date: string
  warc_custom_id: string
  uri: string
  ip: string | null
  content_type: string | null
}

/**
 * One capture in a search result. Deliberately narrow: these six columns are
 * everything WarcSearchResults renders. headers/http_version/ip/content_type
 * were removed from the query rather than left unused — headers alone meant a
 * JSONB detoast per row in Postgres and a JSON.parse per row in the API.
 */
export interface WarcSearchResponseRow {
  response_id: number
  status: number
  last_modified: string | null
  archived_date: string
  warc_custom_id: string
  uri: string
}

export interface SearchCursor {
  /** uris.recursion_level of the page's last URI. */
  level: number
  /** The page's last URI. Together with `level` this is a position in the sort. */
  uri: string
}

export interface WarcSearchApiResponse {
  total_count: number
  /*
   * Where this page ended, so the NEXT one can be asked for by position rather
   * than by "skip N rows".
   *
   * Following it is 49-227x cheaper than the equivalent OFFSET and flat in depth,
   * because OFFSET makes Postgres walk and discard the whole ordered prefix every
   * time. Optional on purpose: an older backend omits it, an empty page has none,
   * and a caller without one falls back to `offset`, which always works.
   */
  next_cursor?: SearchCursor | null
  /*
   * True when the backend stopped counting at its cap instead of finishing.
   *
   * An exact COUNT(*) over a term matching 16% of the corpus took 10.5 seconds
   * — longer than fetching the results themselves by two orders of magnitude —
   * so the backend now counts to 10,001 and stops. When this is set,
   * `total_count` is a floor ("10,000+"), not a total, and rendering it as an
   * exact figure would be stating a number the server never established.
   *
   * Optional: absent from an older backend, and absent means uncapped.
   */
  count_capped?: boolean
  groups: Array<{
    uri: string
    count: number
    responses: WarcSearchResponseRow[]
  }>
  /*
   * Set only when the backend could not be asked at all.
   *
   * The distinction this exists to preserve: an empty `groups` means "the
   * archive holds nothing matching that query", which is a real answer. A
   * backend that is down produces the same empty array and it is NOT the same
   * statement — telling a reader "no results for 5am" when the truth is "we
   * could not look" is a wrong answer delivered confidently.
   *
   * Optional, so every existing reader of this type is unaffected; only the
   * code that wants to tell the two apart has to look.
   */
  unavailable?: Unavailable
}

/**
 * The recent-archives reading, plus whether it is a reading at all.
 *
 * A wrapper rather than a bare array, because an empty array cannot say WHY it
 * is empty, and "the archive holds nothing yet" and "we could not ask" are
 * different sentences to put in front of a reader.
 */
export interface WarcLatestResult {
  archives: WarcLatestResponse[]
  unavailable?: Unavailable
  /*
   * These rows came from a snapshot, not from the backend.
   *
   * The distinction `unavailable` draws is "we could not look"; this one is "we
   * looked, failed, and are showing you the last answer we had". Both are
   * failures and neither may be presented as a fresh reading — a caller that
   * ignores `stale` is telling the reader something untrue, which is the exact
   * failure mode lib/snapshot.ts exists to avoid rather than to create.
   */
  stale?: true
  /** ISO 8601. Present whenever `stale` is. Show it. */
  savedAt?: string
}

export interface WarcStatus {
  /*
   * NEVER "ok" for a snapshot reading, however good the numbers look.
   *
   * A snapshot can supply a believable file count and size, and reporting that
   * as `ok` would destroy the only signal the rest of the app has for "the
   * backend answered". Snapshot readings are `error` + `stale` + `savedAt`, and
   * a caller that wants to show the numbers anyway is free to — it just has to
   * do so knowingly, and say when they were taken.
   */
  status: "ok" | "error"
  /** Number of .warc files in the warc folder. */
  files: number
  /** Total on-disk size of those .warc files, in bytes. */
  total_bytes: number
  /** Server time (ISO 8601). */
  date: string
  /** Present when status is "error" — surfaced to the user. */
  message?: string
  /** The numbers came from a snapshot. See WarcLatestResult.stale. */
  stale?: true
  /** ISO 8601. Present whenever `stale` is. Show it. */
  savedAt?: string
}

// One capture row from /api/warcs/info (the response_payloads shape).
export interface WarcInfoRow {
  id: number | string
  record_id: number | string
  warc_custom_id: string
  file_path: string | null
  byte_offset: number | null
  byte_length: number | null
  status: number
  http_version: string
  content_type: string | null
  uri: string | null
  archived_date: string
  /**
   * The stored response headers.
   *
   * The endpoint has always returned these and this type has never declared
   * them, so the viewer could not see that a capture was a redirect — it showed
   * the empty body of a 301 with nothing saying so, and Save handed back the
   * 1,206-byte stub instead of the page. `location` is the one field that
   * matters here; the rest come along because the row does.
   */
  headers?: Record<string, unknown> | string | null
}

/** A response header by name, case-insensitively, from a row's stored JSONB. */
export function headerOf(
  headers: WarcInfoRow["headers"],
  name: string,
): string | undefined {
  if (!headers) return undefined

  // Bun's SQL client usually decodes JSONB for us and sometimes hands back the
  // string. Both shapes reach here.
  const table: Record<string, unknown> =
    typeof headers === "string"
      ? (() => { try { return JSON.parse(headers) } catch { return {} } })()
      : headers

  const want = name.toLowerCase()

  for (const key of Object.keys(table)) {
    if (key.toLowerCase() === want) {
      const value = table[key]
      return typeof value === "string" ? value : undefined
    }
  }

  return undefined
}

/** Whether a capture is a redirect rather than a page. */
export const isRedirect = (status: number): boolean => status >= 300 && status < 400

/**
 * The capture of `uri` nearest `dateNear`, or null.
 *
 * Server-side twin of the lookup the viewer does in the browser. It exists so a
 * page landing on a redirect can resolve where that redirect POINTS before it
 * renders — the destination's id is what Save has to target, and what the
 * "follow" control has to route to.
 *
 * `redirect=false` on purpose: this is already resolving one hop and following a
 * second here would skip past a chain the reader should be shown.
 */
export function getNearestCaptureReal(
  uri: string,
  dateNear?: string,
): Promise<WarcInfoRow | null> {
  const params = new URLSearchParams({ uri })
  if (dateNear) params.set("dateNear", dateNear)

  return getJson<unknown>(`/api/warcs/near?${params}`)
    .then((data) => {
      // The route answers with the raw Bun.sql result, which is a row ARRAY even
      // for its LIMIT 1 query. Both shapes accepted so this survives a tidy-up.
      const row = Array.isArray(data) ? data[0] : data
      return row && typeof row === "object" ? (row as WarcInfoRow) : null
    })
    .catch((error) => {
      unstable_rethrow(error)
      console.error("Error resolving nearest capture:", error)
      return null
    })
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"

  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}

/**
 * How long to wait for the backend before giving up.
 *
 * Nothing in this file had a bound, and "no answer" is this backend's ACTUAL
 * failure mode rather than a hypothetical one: the box it runs on drops off the
 * LAN when the router reboots, and a wedged Wi-Fi card is a black hole — the
 * connection is accepted by nobody and refused by nobody, so a bare fetch waits
 * forever. Two of the three uncached readers here are awaited by a page with no
 * <Suspense> above them, and bot responses are buffered rather than streamed
 * (base-server.js: `supportsDynamicResponse: !botType`), so an unbounded hang is
 * a crawler timeout on a blank document with nothing in the log to explain it.
 *
 * ## This number is half of a budget that lives in two files
 *
 * The other half is SEARCH_CEILING_MS in backend/db.ts, which caps how long
 * Postgres will spend on one search. The two are related by:
 *
 *     SEARCH_CEILING_MS + transport overhead  <  BACKEND_TIMEOUT_MS
 *
 * and backend/db.ts asserts that at module load, so the build fails rather than
 * the site, if anyone edits one without the other. Change this number and check
 * that assertion still holds.
 *
 * The "~1.5s measured worst case" this comment used to claim was wrong by an
 * order of magnitude and had been since the corpus grew. Re-measured 2026-09-16:
 * the slowest search was 18.9s, because the backend abandoned a 1.3s query for an
 * 18.9s one and this timeout fired first — which is the failure the reader saw as
 * "your search was not run". With the backend's hedge in place the slowest
 * measured search is ~1.7s (kiwifarms.net at offset 1600), and the backend now
 * refuses to exceed 7s, so this 10s is a backstop for transport rather than the
 * thing that decides when a search fails.
 *
 * The same pattern is already used in app/sitemap.ts, which was written after a
 * build hung on exactly this.
 *
 * A TimeoutError lands in each caller's existing catch and describeFailure
 * already classifies it (see the AbortError/TimeoutError branch) — that branch
 * has been unreachable until now, because nothing ever timed out.
 */
const BACKEND_TIMEOUT_MS = 10_000

/**
 * The lifetime a FAILED reading gets.
 *
 * Deliberately not a preset. Both numbers are boundary values in the installed
 * Next: MIN_PRERENDERABLE_EXPIRE and MIN_SHELL_STALE are both 300, and the
 * checks that exclude an entry from the static shell are strict `<`. So 300/300
 * is the shortest failure lifetime that still lets the entry sit in the
 * prerendered shell — one second lower and a degraded read would punch a
 * dynamic hole in a page that must prerender.
 *
 * `revalidate: 30` is the part that does the work: in production the default
 * cache handler's retention is `entry.revalidate` (the `expire` field is only
 * consulted under a dev server), so this is what actually decides how long a
 * failure is served. Thirty seconds of a stale failure, not an hour.
 */
export const DEGRADED_CACHE_LIFE = { stale: 300, revalidate: 30, expire: 300 } as const

/**
 * One GET + JSON parse against the backend. Rejects on a non-2xx so each caller
 * only has to decide what its own failure mode is (rethrow vs. empty fallback).
 */
function getJson<T>(path: string): Promise<T> {
  return fetch(`${API_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    return response.json() as Promise<T>
  })
}

/**
 * Most recently archived HTML pages. Rejects on failure — the callers
 * (ArchiveList, ArchiveStatusBar) render inside an ErrorBoundary.
 */
export async function getLatestArchivedReal(limit = 8): Promise<WarcLatestResult> {
  "use cache"
  /*
   * Cached because every visitor sees the same eight captures, and because two
   * components ask for them.
   *
   * ArchiveList renders the rows and ArchiveStatusBar renders "N archives
   * shown", and both called this independently — two identical round trips to
   * the backend on every single homepage render. `limit` is part of the cache
   * key, so both now resolve to one entry and one fetch.
   *
   * The bigger effect is WHERE the result ends up. An uncached read can only be
   * awaited inside <Suspense>, so it streamed at request time and the reader got
   * a skeleton first. A cached one completes during prerendering and ships in the
   * static shell, so the list is in the first byte of HTML.
   *
   * `minutes` rather than `hours`: this list changes when a parse run finishes,
   * which is a thing that happens by hand and should be visible soon after
   * without waiting out a long window. The tag is the precise lever — see
   * revalidateTag("archives", "max") in app/api/revalidate/route.ts — and the
   * lifetime is just the backstop for when nothing thought to pull it.
   */
  cacheTag("archives")

  /*
   * Resolves to an `unavailable` result rather than throwing - same reason as
   * searchWarcRecordsReal below, and this is the call that actually took the
   * site down: with the backend off, `/` answered 500, and `next build` aborted
   * with "Export encountered an error on /page: /" because the homepage is
   * prerendered and this throw happened during export.
   *
   * ONE CONSEQUENCE WORTH KNOWING: both callers are "use cache" components on
   * cacheLife("minutes"), so an unavailable result is cached for that window
   * too. A reader who reloads immediately after the backend comes back may
   * still see the notice until the entry ages out, or until someone POSTs to
   * app/api/revalidate (which calls revalidateTag("archives", "max") — note the
   * required second argument). That is a deliberate trade - it also stops a
   * down backend from being hammered once per render - and it is why the panel
   * does not promise that reloading fixes it straight away.
   */
  return getJson<WarcLatestResponse[]>(
    `/api/warcs/latest?limit=${limit}&contentType=text/html`,
  )
    .then((archives) => {
      /*
       * Recorded on the way past. Fire and forget — a failed write must never
       * turn a working page into a broken one, which is why writeSnapshot
       * swallows its own errors rather than returning a promise to handle.
       *
       * GUARDED ON LENGTH, and this guard is load-bearing. A backend that is up
       * but answers `[]` — mid-reset, a bad query, a freshly emptied database —
       * would otherwise overwrite good remembered rows with nothing, and the
       * failure path below only falls back when the snapshot is non-empty. One
       * empty success would therefore permanently disarm the protection this
       * whole tier exists to provide, silently and without any failure to log.
       */
      if (archives.length > 0) writeSnapshot("latest", archives, new Date().toISOString())
      cacheLife("minutes")
      return { archives }
    })
    .catch((error) => {
      unstable_rethrow(error)
      console.error("Error fetching latest archived:", error)
      cacheLife(DEGRADED_CACHE_LIFE)

      /*
       * Older rows beat an apology, and beat them for a reason that is not
       * aesthetic: the regeneration this failure happens inside SUCCEEDS
       * either way, and whatever it returns is what gets written over the
       * homepage's prerendered HTML and served for the rest of the outage. So
       * the choice is not "panel now vs rows now" — it is "panel for days vs
       * rows for days".
       *
       * Sliced because the seed holds whatever the backend returned when it was
       * captured, which is not necessarily this caller's `limit`.
       */
      const snapshot = readSnapshot<WarcLatestResponse[]>("latest")
      if (snapshot && snapshot.value.length > 0) {
        return {
          archives: snapshot.value.slice(0, limit),
          stale: true as const,
          savedAt: snapshot.savedAt,
        }
      }

      return { archives: [], unavailable: describeFailure(error) }
    })
}

/**
 * The page size the canonical cache is built around.
 *
 * Must equal components/WarcSearch/resultsQuery.ts's PAGE_SIZE. Not imported
 * from there because that module imports this one; the dispatch below simply
 * declines to cache anything that does not match, so a drift costs a cache miss
 * rather than a wrong answer.
 */
const SEARCH_CANONICAL_LIMIT = 16

/**
 * One cached search: page 1, no filter, nothing else.
 *
 * This shape and no other, because it is exactly what the 476 sitemap'd
 * /warcs/search/<host> URLs request and what a crawler therefore asks for. The
 * full (query x offset x limit x contentType) space is attacker-reachable and
 * would mint an entry per combination; page 1 unfiltered bounds the key space
 * to the set of queries anyone actually visits.
 *
 * The lifetime is conditional for the same reason it is everywhere else in this
 * file: searchWarcRecordsReal resolves a failure to a VALUE, so without the
 * branch below an outage would be cached as "no results for this site" for an
 * hour — on the largest block of indexable URLs on the site.
 *
 * What this costs, stated plainly: search was the one reading where the backend
 * coming back was visible on the very next request. It no longer is. That trade
 * is only acceptable because app/api/revalidate/route.ts exists to clear the
 * tag on demand; without it, a finished parse run would be invisible for an hour.
 */
async function searchCanonicalCached(query: string): Promise<WarcSearchApiResponse> {
  "use cache"
  /*
   * Two tags: the shared one a parse run clears wholesale, and a per-query one
   * so a future caller could refresh a single site without flushing 476 entries.
   * Truncated because cacheTag silently DROPS a tag longer than 256 characters —
   * it warns to the console and carries on, which is the kind of failure nobody
   * notices until the invalidation they were relying on quietly does nothing.
   */
  cacheTag("archives", `search:${query.slice(0, 200)}`)

  return fetchSearchResponse(query, 0, SEARCH_CANONICAL_LIMIT, null).then((result) => {
    if (result.unavailable) cacheLife(DEGRADED_CACHE_LIFE)
    else cacheLife("hours")
    return result
  })
}

export function searchWarcRecordsReal(
  query: string,
  offset = 0,
  limit = 16,
  contentType?: string | null,
  cursor?: SearchCursor | null,
): Promise<WarcSearchApiResponse> {
  /*
   * Only the canonical shape is cached. Everything else — deep pages, a content
   * type filter, a caller with its own limit — goes straight to the backend as
   * before, so the cache cannot be filled by walking query parameters.
   */
  if (offset === 0 && limit === SEARCH_CANONICAL_LIMIT && !contentType && !cursor) {
    return searchCanonicalCached(query)
  }

  return fetchSearchResponse(query, offset, limit, contentType, cursor)
}

/** The uncached request itself, shared by both paths above. */
function fetchSearchResponse(
  query: string,
  offset: number,
  limit: number,
  contentType?: string | null,
  cursor?: SearchCursor | null,
): Promise<WarcSearchApiResponse> {
  const params = new URLSearchParams({
    q: query,
    offset: offset.toString(),
    limit: limit.toString(),
  })
  if (contentType) params.set("content_type", contentType)
  /*
   * `offset` is still sent alongside the cursor and the backend ignores it when a
   * cursor is present. Kept so the request is self-describing in a log, and so a
   * backend that predates the cursor answers the right page instead of page 1.
   */
  if (cursor) {
    params.set("after_level", String(cursor.level))
    params.set("after_uri", cursor.uri)
  }

  /*
   * Returns an `unavailable` result instead of throwing.
   *
   * This used to `throw new Error("Failed to search WARC records")`, and because
   * WarcSearchResults is a SERVER component the throw happened during the Server
   * Components render. React does not forward that message to the browser in a
   * production build — it substitutes its own:
   *
   *   "Minified React error #441 ... The specific message is omitted in
   *    production builds to avoid leaking sensitive details."
   *
   * So the reader got a stack-trace panel whose text was about React's error
   * encoding, with no hint that the archive backend was simply down. The string
   * we carefully wrote never reached anyone.
   *
   * Degrading to a value keeps the failure on the server's terms, renderable and
   * specific. unstable_rethrow still runs FIRST, so Next's own control-flow
   * signals (postpone, redirect, notFound) are untouched — see the long note at
   * the top of this file.
   */
  return getJson<WarcSearchApiResponse>(`/api/warcs/search?${params}`).catch((error) => {
    unstable_rethrow(error)
    console.error("Error searching WARC records:", error)

    return { total_count: 0, groups: [], unavailable: describeFailure(error) }
  })
}

/*
 * Why a failure is a VALUE in this file and not an exception
 * ---------------------------------------------------------------------------
 * Every reader of the archive API here runs inside a Server Component. A throw
 * there does not reach the browser: React substitutes its own text, and in a
 * production build that text is
 *
 *   "Minified React error #441 ... The specific message is omitted in
 *    production builds to avoid leaking sensitive details."
 *
 * which tells a reader nothing except that something was hidden from them. So
 * the functions below resolve to a shape carrying an `unavailable` marker, and
 * the components decide how to say it.
 */

/**
 * The distinguishable ways asking the backend can fail.
 *
 * Separate from the message because the presentation differs: `offline` is worth
 * a retry in a moment, `notFound` means this build is talking to an older
 * backend and retrying will never help, and `denied` is nobody's transient blip.
 */
export type UnavailableKind =
  | "offline"    // nothing answered - connection refused, DNS, tunnel down
  | "timeout"    // answered too late, or a proxy gave up (502/503/504)
  | "server"     // reached it, it failed (other 5xx)
  | "notFound"   // 404 - route absent, usually a version skew
  | "denied"     // 401/403
  | "throttled"  // 429
  | "rejected"   // other 4xx - we asked for something wrong
  | "malformed"  // answered with something that is not the JSON we expected

export interface Unavailable {
  kind: UnavailableKind
  /** Human-readable and safe to render. Never a stack, host, or port. */
  reason: string
  /** Present only when a response actually arrived. */
  status?: number
}

/**
 * Classify a rejection into something safe to show a reader.
 *
 * Deliberately does NOT forward `error.message`. A connection failure surfaces
 * as "fetch failed" with a cause naming our host and port - meaningless to a
 * reader, and more about our topology than they need to be told.
 */
export function describeFailure(error: unknown): Unavailable {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ""

  // getJson throws `HTTP error! status: NNN` for any non-2xx.
  const parsed = Number(/status:\s*(\d{3})/.exec(message)?.[1])
  const status = Number.isFinite(parsed) ? parsed : undefined

  if (status !== undefined) {
    if (status === 502 || status === 503 || status === 504) {
      return { kind: "timeout", status, reason: "The archive backend did not respond in time." }
    }
    if (status === 404) {
      return {
        kind: "notFound",
        status,
        reason: "That part of the archive API is missing - the backend may be an older version than this site expects.",
      }
    }
    if (status === 401 || status === 403) {
      return { kind: "denied", status, reason: "The archive backend refused the request." }
    }
    if (status === 429) {
      return { kind: "throttled", status, reason: "Too many requests - the archive backend is rate limiting." }
    }
    if (status >= 500) {
      return { kind: "server", status, reason: `The archive backend hit an internal error (HTTP ${status}).` }
    }
    return { kind: "rejected", status, reason: `The archive backend rejected the request (HTTP ${status}).` }
  }

  // A body that arrived but would not parse. Distinct from no answer at all:
  // it usually means something in front of the backend answered instead - a
  // proxy error page, or a captive portal.
  if (name === "SyntaxError" || /JSON|Unexpected token/i.test(message)) {
    return { kind: "malformed", reason: "The archive backend returned a response this site could not read." }
  }

  if (name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(message)) {
    return { kind: "timeout", reason: "The request to the archive backend timed out." }
  }

  return { kind: "offline", reason: "The archive backend could not be reached." }
}

/**
 * Distinct base content types currently stored ("text/html", "image/png", ...),
 * sorted A->Z, for the search filter dropdown. Returns [] on error.
 *
 * Deliberately does NOT go through getJson(): a missing route (e.g. the backend
 * hasn't been restarted with it yet) must not throw at all, because Next's dev
 * overlay surfaces thrown errors even when they are caught. The search page
 * still renders, with an "Any type"-only dropdown.
 */
export async function getContentTypesReal(): Promise<string[]> {
  "use cache"
  /*
   * The distinct MIME types in the corpus, for the search filter dropdown.
   *
   * The longest lifetime of the three, because this is the slowest-moving thing
   * on the site: a parse run adds a type only when it meets a kind of file the
   * archive has never held before. Tagged with the same "archives" tag as the
   * rest, so one revalidation covers everything a parse run can change.
   */
  /*
   * The tag is unconditional; the LIFETIME is not, and that split is the point.
   *
   * This function could not see its own failures. `response.ok ? … : []` turned
   * a 500 into a value byte-identical to "the corpus holds no content types" —
   * no throw, so it never reached unstable_rethrow or describeFailure, and no
   * log line either. That empty list was then cached on the `hours` profile.
   *
   * It is awaited in the static shell of /warcs/search, at the top of every one
   * of the 476 /warcs/search/<host> pages, and on the homepage via
   * components/SearchBar/SearchBar.tsx — so one second of backend flapping
   * silently emptied the filter dropdown on three indexable page classes for an
   * hour, and nothing anywhere said so.
   *
   * Now a real answer earns `hours` and a failure gets DEGRADED_CACHE_LIFE. One
   * cacheLife call per path, which is what the conditional-lifetime docs ask
   * for; the nesting below is what guarantees it, since a json() that rejects
   * after a 200 falls through to the catch having set no lifetime at all.
   */
  cacheTag("archives")

  /*
   * Still NOT routed through getJson, deliberately — see the note above this
   * function. getJson throws on a non-2xx and Next's dev overlay surfaces a
   * thrown error even when it is caught, so a backend without this route yet
   * would fill the overlay on every render. Branching on `response.ok` keeps
   * that quiet while still making the failure visible in the log and short in
   * the cache. The timeout has to be repeated here for the same reason.
   */
  return fetch(`${API_BASE_URL}/api/warcs/content-types`, {
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  })
    .then((response) => {
      if (!response.ok) {
        console.error(`Error fetching content types: the backend answered HTTP ${response.status}`)
        cacheLife(DEGRADED_CACHE_LIFE)
        // The SAME fallback the catch branch takes. Leaving it out here made the
        // two failure paths disagree: a 500 emptied the dropdown while a dropped
        // connection did not, and an empty list silently drops every
        // ?content_type= filter (normalizeContentType rejects anything not in
        // the known list). Both are failures; both get the last known answer.
        return readSnapshot<string[]>("content-types")?.value ?? []
      }

      return (response.json() as Promise<unknown>).then((data) => {
        cacheLife("hours")
        const types = Array.isArray(data)
          ? data.filter((x): x is string => typeof x === "string")
          : []
        if (types.length > 0) writeSnapshot("content-types", types, new Date().toISOString())
        return types
      })
    })
    .catch((error) => {
      unstable_rethrow(error)
      console.error("Error fetching content types:", error)
      cacheLife(DEGRADED_CACHE_LIFE)
      // An empty dropdown is indistinguishable from "this corpus has no types",
      // which is the confusion this whole function was rewritten to end. The
      // last known list is a strictly better answer than that.
      return readSnapshot<string[]>("content-types")?.value ?? []
    })
}

/**
 * Backend status from /api/warcs/status. Never rejects: an unreachable or
 * unhealthy backend resolves to { status: "error", message } so the UI can show
 * a banner instead of crashing.
 */
/**
 * A failed status reading, backed by the last known numbers if there are any.
 *
 * Shared by BOTH failure paths — the unreachable backend and the 200 whose body
 * says "error" — because they are the same event to a reader and were being
 * handled differently only by accident.
 *
 * status stays "error" even with perfectly good numbers in hand, and that is
 * the single most important line in this file's snapshot handling. Reporting
 * "ok" would make a snapshot indistinguishable from a live reading — exactly
 * the confusion the rest of this work exists to remove — and it would do it in
 * the one field every other component uses to decide whether the archive is
 * reachable. A caller that wants the numbers anyway reads `stale` and prints
 * `savedAt`.
 */
const degradedStatus = (reason: string): WarcStatus => {
  const snapshot = readSnapshot<WarcStatus>("status")

  if (snapshot) {
    return {
      ...snapshot.value,
      status: "error" as const,
      message: reason,
      stale: true as const,
      savedAt: snapshot.savedAt,
    }
  }

  return {
    status: "error" as const,
    files: 0,
    total_bytes: 0,
    date: new Date().toISOString(),
    message: reason,
  }
}

export async function getWarcStatusReal(): Promise<WarcStatus> {
  "use cache"
  /*
   * File count and total bytes of the warc folder, for the footer.
   *
   * Note what caching does to the `date` field: it stops being "now" and becomes
   * "when these numbers were read", which is what the footer should have been
   * showing all along. A timestamp regenerated per request is exactly the kind of
   * value Cache Components asks you to be deliberate about, and the deliberate
   * answer here is that it belongs to the reading, not to the request.
   */
  cacheTag("archives")

  return getJson<Record<string, unknown>>("/api/warcs/status")
    .then((data) => {
      const reading = {
        status: data?.status === "error" ? ("error" as const) : ("ok" as const),
        files: Number(data?.files ?? 0) || 0,
        total_bytes: Number(data?.total_bytes ?? 0) || 0,
        date: typeof data?.date === "string" ? data.date : new Date().toISOString(),
        message: typeof data?.message === "string" ? data.message : undefined,
      }

      if (reading.status === "ok") {
        // Only a healthy reading is worth keeping: snapshotting a backend that
        // answered "error" would preserve the failure rather than insure against it.
        writeSnapshot("status", reading, reading.date)
        cacheLife("minutes")
        return reading
      }

      /*
       * A 200 whose BODY says "error" is a failure, and it never reaches the
       * catch below — getJson only throws on a non-2xx, and the backend answers
       * 200 for this case by design (backend/routes/status.tsx returns
       * `{status:"error", message, date}` with no status argument when reading
       * the warc folder throws).
       *
       * It was previously falling through to the success path, which got it
       * twice wrong: the success lifetime was applied to a failed reading (60s
       * retention instead of 30s), and the snapshot fallback was skipped, so
       * /about and /warcs showed zeroes while perfectly good remembered numbers
       * sat on disk. Same treatment as an unreachable backend now.
       */
      cacheLife(DEGRADED_CACHE_LIFE)
      return degradedStatus(reading.message ?? "The archive backend reported an error.")
    })
    .catch((error) => {
      unstable_rethrow(error)
      console.error("Error fetching WARC status:", error)
      cacheLife(DEGRADED_CACHE_LIFE)

      /*
       * describeFailure, not error.message — this was the one place in the
       * file that forwarded a raw error string to a rendered field, against
       * the policy stated where describeFailure is defined. It reaches the
       * footer of every page via SystemStatsServer, so it was already showing
       * readers "fetch failed" naming our own host and port; with a timeout
       * now in play it would have started showing "The operation was aborted
       * due to timeout", which is worse.
       */
      return degradedStatus(describeFailure(error).reason)
    })
}

/**
 * Every capture of the same URL as the given record. The backend resolves the
 * URL from the warc_custom_id (get_site_responses), so a single call returns the
 * full capture history. Returns [] on error so callers can render regardless.
 */
export function getRecordSiteHistoryReal(warcCustomId: string): Promise<WarcInfoRow[]> {
  return getJson<unknown>(`/api/warcs/info?id=${encodeURIComponent(warcCustomId)}`)
    .then((data) => (Array.isArray(data) ? (data as WarcInfoRow[]) : []))
    .catch((error) => {
      unstable_rethrow(error)
      console.error("Error fetching record site history:", error)
      return []
    })
}
