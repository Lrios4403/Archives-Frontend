import { cache } from "react"
import { searchWarcRecordsReal, type WarcSearchApiResponse } from "@/lib/db"

/*
 * One definition of "what this search page is asking for", shared by the three
 * places that need to agree about it: generateMetadata, the page body, and
 * WarcSearchResults.
 *
 * It exists because generateMetadata now has to see the RESULT in order to
 * decide whether the page is indexable, and the page body needs the same result
 * to render. If those two derive their arguments separately they will drift —
 * and a drift of one character means two different queries for one page view,
 * against the slowest route on the site.
 */

/** Sites (matching URIs) per page. Owned here so every caller agrees. */
export const PAGE_SIZE = 16

/**
 * The count the backend reports once it stops counting.
 *
 * It caps at 10,000 but returns 10,001 to signal "more than the cap" — so the
 * pager, which computes its page count from the number it is given, offers
 * ceil(10001/16) = 626 pages. Deriving the clamp from 10,000 instead produced
 * 625 and put the final "Next" link one page beyond what would be accepted:
 * the last page rendered the previous page's rows and linked to itself.
 */
const CAPPED_TOTAL = 10_001

/**
 * The last page anyone can reach, for any query.
 *
 * Before this clamp, `?page=999999` was a free database query for a page
 * nothing links to and that renders empty — the shape of a crawl trap.
 *
 * Lower this and the pager follows, because pageCount below is the only thing
 * that answers "how many pages does this result have". That was not always
 * true; see the note there before touching either.
 */
export const MAX_PAGE = Math.ceil(CAPPED_TOTAL / PAGE_SIZE)

/**
 * How many pages a result holding `totalSites` sites is allowed to claim.
 *
 * THE ONLY PLACE that number is computed, which is the entire point of it
 * existing. WarcSearchResults used to do its own
 *
 *     Math.max(1, Math.ceil(totalSites / PAGE_SIZE))
 *
 * and never consult MAX_PAGE — the same arithmetic as the clamp above, written
 * out a second time in another file, agreeing with it only by coincidence.
 * normalizePage clamps the incoming `?page=` to MAX_PAGE, so the two disagreeing
 * is not a cosmetic mismatch: lower MAX_PAGE to 100 on its own and the pager
 * still offers 626 pages, while every request for one of them is clamped back to
 * 100 and served page 100's rows. That is 526 distinct URLs rendering identical
 * content, each one carrying a "Next" link to the next identical URL, with
 * nothing in the output that looks wrong.
 *
 * Clamped rather than asserted: a capped `total_count` is a floor, not a total
 * (see count_capped in lib/db), so a total larger than the cap allows for is an
 * ordinary input here and not a bug to throw on. `|| 1` catches the NaN that a
 * missing or unparsable count arrives as; Infinity clamps to MAX_PAGE like any
 * other over-large value.
 */
export const pageCount = (totalSites: number): number =>
  Math.min(Math.max(1, Math.ceil(totalSites / PAGE_SIZE) || 1), MAX_PAGE)

/**
 * `?page=` as a number the rest of the code can trust.
 *
 * Truncated, not just clamped. `Number("1.5")` is 1.5, which survived the clamp
 * and reached the backend as `OFFSET 8` — a half-page window under a distinct
 * URL, rendering rows that overlap page 1 and 2 and labelling itself "1.5".
 * Every fractional value between two integers is its own cacheable URL, so the
 * unbounded key space the clamp was added to close was still open through the
 * decimal point.
 */
export const normalizePage = (raw: string | undefined): number =>
  Math.min(Math.max(1, Math.trunc(Number(raw)) || 1), MAX_PAGE)

/**
 * `?content_type=` validated against the types the corpus actually holds.
 *
 * It was read raw and passed straight to the backend, three lines below the
 * call that fetches the list of valid values and never compared against it. An
 * unknown type now falls back to "any type" rather than reaching the database
 * and returning nothing — a behaviour change, and the better behaviour.
 */
export const normalizeContentType = (
  raw: string | undefined,
  known: readonly string[],
): string | undefined => (raw && known.includes(raw) ? raw : undefined)

/**
 * The search itself, memoised for the duration of one request.
 *
 * React's `cache` rather than relying on fetch memoisation, deliberately. The
 * docs say identical `fetch` calls dedupe across generateMetadata and the page,
 * but lib/db.tsx now passes an `AbortSignal.timeout(...)` — a fresh object on
 * every call — and whether the memo key survives that is an implementation
 * detail I am not willing to bet the slowest route on. `cache` keys on the
 * arguments below, which are plain values, so the behaviour is decidable by
 * reading this file.
 *
 * Request-scoped only: it holds nothing between requests and is not a
 * substitute for "use cache". Its whole job is to stop ONE page view from
 * asking the same question twice.
 */
/**
 * `?after_level=` / `?after_uri=` as a cursor the rest of the code can trust.
 *
 * Both halves or neither: a level without a uri names no position, and a uri
 * without a level cannot be compared against the (recursion_level, uri) sort. A
 * half-supplied cursor is dropped rather than guessed at, and the caller falls
 * back to `?page=`, which always works.
 *
 * `level` is legitimately 0, so it is validated with Number.isFinite rather than
 * truthiness — the bug that pattern invites is a cursor into recursion level 0
 * silently becoming "no cursor".
 */
export const normalizeCursor = (
  levelRaw: string | undefined,
  uriRaw: string | undefined,
): { level: number; uri: string } | undefined => {
  if (!uriRaw) return undefined

  const level = Number(levelRaw)

  return Number.isFinite(level) ? { level: Math.trunc(level), uri: uriRaw } : undefined
}

/**
 * The search itself, memoised for the duration of one request.
 *
 * The cursor is passed as two PLAIN values rather than an object, and that is
 * deliberate: React's `cache` keys on argument identity, so a fresh
 * `{ level, uri }` literal on each call would miss the memo every time and this
 * route would run its slowest query twice per view — once in generateMetadata
 * and once in the body. Two primitives compare by value and hit.
 */
export const fetchResults = cache(
  (
    query: string,
    page: number,
    contentType?: string,
    cursorLevel?: number,
    cursorUri?: string,
  ): Promise<WarcSearchApiResponse> =>
    searchWarcRecordsReal(
      query,
      (page - 1) * PAGE_SIZE,
      PAGE_SIZE,
      contentType,
      cursorUri !== undefined && cursorLevel !== undefined
        ? { level: cursorLevel, uri: cursorUri }
        : null,
    ),
)
