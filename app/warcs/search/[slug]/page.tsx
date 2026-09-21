import WarcSearchInterface from "@/components/WarcSearch/WarcSearchInterface"
import WarcSearchResults from "@/components/WarcSearch/WarcSearchResults"
import ErrorBoundary from "@/components/ErrorBoundary/ErrorBoundary"
import type { Metadata } from "next"
import { queryFromSlug, searchHref } from "@/components/WarcSearch/actions"
import { fetchResults, normalizeContentType, normalizeCursor, normalizePage } from "@/components/WarcSearch/resultsQuery"
import { pageMetadata } from "@/lib/site"
import { getContentTypesReal } from "@/lib/db"
import PageHeader from "@/components/PageHeader/PageHeader"
import { breadcrumbSchema, collectionPageSchema, jsonLd } from "@/lib/schema"

/*
 * Search results, as a blocking route with no <Suspense> in it.
 *
 * Both of those together, because neither works alone. Under Cache Components a
 * route may not await request data outside a boundary unless it opts out of the
 * instant shell — and anything left inside a boundary is postponed, and
 * postponed content does not hydrate on Next 16.3.2. Adding `instant = false`
 * while keeping the boundaries was measured at 3 postponed boundaries and a
 * completely inert page; removing them takes it to 0 and everything works.
 *
 * What it costs: this page no longer answers instantly with a shell. It waits
 * for the search query before sending anything. The landing page next door is
 * static and absorbs that — a reader who has not searched yet gets the fast
 * page, and a reader who has is waiting on results either way. The old design
 * paid the same wait and showed a skeleton during it.
 */
export const instant = false

interface ResultsSearchParams {
  page?: string
  content_type?: string
  /*
   * A cursor from the previous page's "next" link. Optional and never required:
   * a reader who types ?page=47 by hand, or a crawler following a numbered link,
   * supplies neither and gets the offset path, which always works.
   */
  after_level?: string
  after_uri?: string
}

/*
 * Per-query metadata, because "WARC Search" on ten thousand different result
 * pages is one page as far as a search engine is concerned.
 *
 * Two deliberate choices:
 *
 * 1. The canonical always points at page 1 of the bare slug, with no `page` or
 *    `content_type`. Those parameters produce near-identical listings of the
 *    same corpus, and left uncanonicalised each combination is a separate thin
 *    URL competing with the others for the same query.
 *
 * 2. Anything past page 1 is `index: false, follow: false`. Deep pagination is
 *    thin content — a slice of a list, with no text of its own — and the
 *    argument that used to keep `follow` on ("the links are how a crawler
 *    reaches individual captures") does not survive contact with app/robots.ts,
 *    which disallows /warcs/view. See the robots block below.
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<ResultsSearchParams>
}): Promise<Metadata> {
  const [
    { slug },
    { page: pageParam, content_type: contentTypeParam, after_level: afterLevelParam, after_uri: afterUriParam },
    contentTypes,
  ] = await Promise.all([params, searchParams, getContentTypesReal()])

  const query = queryFromSlug(slug)
  /*
   * The canonical is built from the QUERY, not from the slug that was asked for.
   *
   * Several distinct slugs decode to the same query — the double-encoded form
   * this app used to emit, the single-encoded form it emits now, and anything a
   * reader hand-types — and every one of them answers 200. Canonicalising on the
   * raw `slug` made each of them declare ITSELF canonical, which is a pile of
   * duplicate pages for one search. searchHref(query) is the one address the
   * app would produce for this query today, so they all collapse onto it.
   */
  const canonicalPath = searchHref(query)
  /*
   * Normalised through the SAME helpers the page body uses, and that is the
   * whole reason they live in one module. fetchResults is memoised on its
   * arguments for the length of the request, so this call and the one inside
   * WarcSearchResults are one query — but only while both sides derive the
   * arguments identically. Compute `page` differently here and this route
   * quietly runs its slowest query twice per view.
   */
  const page = normalizePage(pageParam)
  const contentType = normalizeContentType(contentTypeParam, contentTypes)
  const cursor = normalizeCursor(afterLevelParam, afterUriParam)
  const deep = page > 1
  const filtered = contentType !== undefined

  // "all" is the browse-everything slug, not a search for the word "all".
  const subject = query ? `"${query}"` : "every archived URL"
  const title = query ? `Archived captures of ${query}` : "Browse every archived URL"

  const description = [
    query
      ? `Archived web pages matching ${subject} in the M4cgyvers WARC collection.`
      : `Browse every URL archived in the M4cgyvers WARC collection.`,
    contentType ? `Filtered to ${contentType}.` : "",
    deep ? `Page ${page}.` : "View captures as they were originally served, with full response headers.",
  ]
    .filter(Boolean)
    .join(" ")

  /*
   * The RESULT decides whether this page is indexable, so the metadata is built
   * inside the continuation rather than after a second await.
   *
   * `index: true` was hard-coded for page 1 regardless of what page 1 actually
   * contained. During a backend outage that published all 476 collection pages
   * — the largest block of URLs on the site — as indexable soft-404s carrying
   * nothing but the failure panel. A page with no results is thin content; a
   * page that could not ask the question is not a page at all. Neither should
   * invite indexing, and both keep `follow` on so the crawler still walks the
   * links — deep pagination is the one withheld state that does not, for
   * reasons set out in the robots block below.
   */
  return fetchResults(query, page, contentType, cursor?.level, cursor?.uri).then((results) => {
    const empty = results.groups.length === 0
    const unavailable = results.unavailable !== undefined

    return pageMetadata({
      title: deep ? `${title} — page ${page}` : title,
      description,
      path: canonicalPath,
      keywords: query ? ["WARC search", query] : ["browse web archive", "WARC search"],
      /*
       * Stated for BOTH branches, never left undefined. `undefined` here does
       * not fall back to the root layout's value — it clears it, and page 1
       * shipped with no robots tag at all. Harmless (absent means indexable)
       * but it made a deliberate policy invisible in the output, which is where
       * you check it.
       *
       * Four reasons to withhold indexing:
       *   deep         - a slice of a list, no text of its own
       *   filtered     - ?content_type= is a near-duplicate of the bare slug,
       *                  and the canonical already points there
       *   empty        - nothing matched; indexing it is publishing a soft 404
       *   unavailable  - we could not ask, so we do not know what this page is
       *
       * DEEP is the one that also withholds `follow`, and it is worth being
       * explicit about why it is alone in that.
       *
       * Work out what `follow` actually buys on a deep page. app/robots.ts
       * disallows /warcs/view and /api/, which is every outbound link a result
       * row carries — the capture links and the download links are already
       * off-limits, so following the page reaches none of them. The site chrome
       * (nav, breadcrumbs, the canonical) is reachable from every other page on
       * the site, including page 1 of this very search, which is still
       * `follow: true`. What is left, and only what is left, is the pagination
       * chain: page 2 links page 3 links page 4, up to 626 per query.
       *
       * That chain is a crawl trap with a measured price. A term like
       * "kiwifarms.net" matches 3.59M URIs, and the ordered query's cost is flat
       * in offset — 2.5s at offset 320, 1.6s at offset 1600 — because the sort
       * key is (recursion_level, uri) and every page re-walks the same fixed
       * prefix of non-matching index entries. So each link in that chain is
       * seconds of database work for a document we have just said not to index,
       * and there are 625 of them per query across 476 sitemap'd queries.
       * `follow: true` was inviting a crawler to walk all of it.
       *
       * The other three keep `follow: true`, and the same argument does not
       * reach them:
       *   filtered     - one page, not a chain. ?content_type= on page 1 is a
       *                  normal offset-0 query (~112ms), and its links point at
       *                  the same canonical destinations the unfiltered page 1
       *                  already offers. Nothing to trap a crawler in.
       *   empty        - there are no result links to follow, and no pager
       *                  either: WarcSearchResults only renders one when
       *                  totalPages > 1, and an empty result on page 1 has one
       *                  page. `follow` costs nothing here, and switching it off
       *                  would drop the site-wide nav links for no gain. (An
       *                  empty page that DOES carry a pager is empty because it
       *                  is deep, and `deep` is tested first.)
       *   unavailable  - the panel is all there is; WarcSearchResults returns it
       *                  before any pager. This state is transient by
       *                  definition, and a backend blip should not emit
       *                  `nofollow` over the whole navigation for however long
       *                  DEGRADED_CACHE_LIFE holds the failure.
       */
      robots: deep
        ? { index: false, follow: false }
        : filtered || empty || unavailable
          ? { index: false, follow: true }
          : { index: true, follow: true },
    })
  })
}

export default async function SearchResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<ResultsSearchParams>
}) {
  const [
    { slug },
    { page: pageParam, content_type: contentTypeParam, after_level: afterLevelParam, after_uri: afterUriParam },
    contentTypes,
  ] = await Promise.all([params, searchParams, getContentTypesReal()])

  // "all" means the empty query, which is a real search matching every URI.
  const query = queryFromSlug(slug)
  // Identical derivation to generateMetadata's — see the note there. These two
  // must agree or fetchResults' memo misses and the page queries twice.
  const page = normalizePage(pageParam)
  const contentType = normalizeContentType(contentTypeParam, contentTypes)
  // Same derivation as generateMetadata's, for the same memo reason.
  const cursor = normalizeCursor(afterLevelParam, afterUriParam)

  const heading = query ? `Archived captures of ${query}` : "Browse every archived URL"
  // Same reasoning as generateMetadata's: one address per query, derived from
  // the query rather than from whichever encoding of it was requested.
  const canonicalPath = searchHref(query)

  return (
    <>
      {/*
        * These pages had NO headings at all - measured: zero h1 and zero h2 on
        * a live slug page. The h1 states the query rather than a generic
        * "Search", so it matches the title and description and tells a reader
        * arriving from a result what they are looking at.
        */}
      <PageHeader
        title={heading}
        subtitle={query ? `Every capture of "${query}" held in the collection` : undefined}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(
          breadcrumbSchema([
            { name: "M4cgyvers Archives", path: "/" },
            { name: "Search", path: "/warcs/search" },
            { name: query || "All URLs", path: canonicalPath },
          ]),
          collectionPageSchema({
            name: heading,
            description: query
              ? `Archived web pages matching "${query}" in the M4cgyvers WARC collection.`
              : "Every URL archived in the M4cgyvers WARC collection.",
            path: canonicalPath,
          }),
        ) }}
      />

      <ErrorBoundary>
        <WarcSearchInterface
          initialQuery={query}
          contentTypes={contentTypes}
          initialContentType={contentType ?? ""}
          searched
        />
      </ErrorBoundary>

      <ErrorBoundary>
        <WarcSearchResults
          query={query}
          page={page}
          contentType={contentType}
          cursorLevel={cursor?.level}
          cursorUri={cursor?.uri}
        />
      </ErrorBoundary>
    </>
  )
}
