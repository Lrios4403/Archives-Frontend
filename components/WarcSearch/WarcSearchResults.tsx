import type { WarcSearchApiResponse } from "@/lib/db"
import { fetchResults, pageCount } from "./resultsQuery"
import Window from "@/components/Window/Window"
import styles from "./WarcSearchResults.module.css"
import SiteResults from "./SiteResults"
import Pagination from "./Pagination"
import { siteAnchors, siteLabel } from "./actions"
import SiteJumpList from "./SiteJumpList"
import Unavailable from "@/components/Unavailable/Unavailable"

// PAGE_SIZE moved to ./resultsQuery, which also owns the offset arithmetic and
// the request-scoped memo. generateMetadata on the slug route needs the SAME
// result this component renders in order to decide whether the page is
// indexable, and the only way those two cannot drift is for both to go through
// one definition. The backend paginates matched URIs via offset/limit;
// total_count is the total number of matching sites.

interface WarcSearchResultsProps {
  query: string
  page?: number
  contentType?: string
  /**
   * Where the previous page ended, when the reader arrived by clicking "next".
   *
   * Two plain values rather than an object, because fetchResults is memoised with
   * React's `cache` and that keys on argument identity — a fresh object literal
   * would miss the memo and run this route's slowest query twice per view, once
   * here and once in generateMetadata.
   */
  cursorLevel?: number
  cursorUri?: string
}

export default async function WarcSearchResults({
  query,
  page = 1,
  contentType,
  cursorLevel,
  cursorUri,
}: WarcSearchResultsProps) {
  const searchResults: WarcSearchApiResponse = await fetchResults(
    query,
    page,
    contentType,
    cursorLevel,
    cursorUri,
  )

  /*
   * One id per group, deduped across the page — a repeated id would make two
   * entries in the list scroll to the same site.
   */
  const anchors = siteAnchors(searchResults.groups.map((group) => group.uri))

  const totalSites = Number(searchResults.total_count) || 0
  const shown = searchResults.groups.length

  /*
   * The count is a floor once the backend caps it, so say so.
   *
   * "10,001" would be a precise-looking lie — the server counted to 10,001 and
   * stopped, and the real figure for a term like "kiwifarms" is 1,690,388.
   * Printing "10,000+" is both shorter and the only honest rendering of what
   * was actually measured.
   */
  const capped = searchResults.count_capped === true
  const totalLabel = capped
    ? `${(totalSites - 1).toLocaleString()}+`
    : totalSites.toLocaleString()

  /*
   * Pagination follows the count, which means a capped count caps the pager at
   * 626 pages. That is a real limit and worth being deliberate about rather
   * than accidental: past ~10,000 sites the deep pages are already noindex'd
   * thin slices, nobody walks to page 105,649 of a 1.7M-row result, and the
   * alternative is paying 10.5 seconds on every single search to compute a
   * page number no reader will ever visit. Narrowing the query gets there.
   *
   * pageCount, NOT a local Math.ceil, and that is a correctness fix rather than
   * tidying. This line used to read
   *
   *     Math.max(1, Math.ceil(totalSites / PAGE_SIZE))
   *
   * which is MAX_PAGE's arithmetic written out a second time here, in a
   * different file, with nothing tying the two together. resultsQuery's
   * normalizePage clamps the incoming `?page=` to MAX_PAGE, so the moment they
   * disagreed the pager offered pages the clamp refuses to honour: each of them
   * comes back to the cap and renders the cap's rows, so a whole run of distinct
   * URLs serve identical content while each still links onward to the next.
   * Both numbers now come out of resultsQuery, so lowering the cap lowers the
   * pager with it and the disagreement is not expressible.
   */
  const totalPages = pageCount(totalSites)

  /*
   * Checked BEFORE the empty-results branch, and that order is the point.
   *
   * An unreachable backend also produces zero groups, so falling through would
   * render "No archived content found for 5am" plus a list of search tips -
   * confidently telling the reader the archive lacks what they asked for, when
   * nothing was searched at all. Same pixels, opposite meaning.
   */
  if (searchResults.unavailable) {
    return (
      <Unavailable
        info={searchResults.unavailable}
        title="Search Unavailable"
        attempted={`Your search for "${query}"`}
      />
    )
  }

  if (shown === 0) {
    return (
      <div className={styles.resultsContainer}>
        <Window title="Search Results" icon="🔍">
          <div className={styles.noResults}>
            <div className={styles.noResultsIcon}>🔍</div>
            <h3 className={styles.noResultsTitle}>No WARC records found</h3>
            <p className={styles.noResultsMessage}>
              No archived content found for "{query}"{page > 1 ? ` on page ${page}` : ""}. Try a different search term
              or an earlier page.
            </p>
            <div className={styles.noResultsSuggestions}>
              <p className={styles.suggestionsTitle}>Try searching for:</p>
              <ul className={styles.suggestionsList}>
                <li>Popular sites: myspace.com, friendster.com</li>
                <li>Web communities: geocities.com</li>
                <li>Social platforms: digg.com, stumbleupon.com</li>
              </ul>
            </div>
          </div>
        </Window>
        {totalPages > 1 && <Pagination query={query} page={page} totalPages={totalPages} contentType={contentType} nextCursor={searchResults.next_cursor} />}
      </div>
    )
  }

  return (
    <div className={styles.resultsContainer}>
      <div className={styles.resultsHeader}> 
          <div className={styles.resultsSummary}>
            <div className={styles.summaryStats}>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Query:</span>
                <code className={styles.summaryValue}>"{query}"</code>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Sites:</span>
                <span className={styles.summaryValue}>
                  {shown} of {totalLabel}
                </span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Page:</span>
                <span className={styles.summaryValue}>
                  {page} of {totalPages}
                </span>
              </div>
            </div>
            {/*
              * Every site on this page, as a jump list.
              *
              * Plain anchors, so this works with no JavaScript and survives
              * middle-click — the results page is a list of sixteen windows and
              * the only way to reach the ninth was to scroll past eight.
              *
              * Hidden for a single result: a menu whose one entry is the thing
              * already filling the screen.
              */}
            {searchResults.groups.length > 1 && (
              <SiteJumpList
                items={searchResults.groups.map((group, index) => ({
                  id: anchors[index]!,
                  label: siteLabel(group.uri),
                  title: group.uri,
                  count: group.count,
                }))}
              />
            )}

            {/* Top page selector so you don't have to scroll to the bottom one. */}
            <Pagination query={query} page={page} totalPages={totalPages} contentType={contentType} nextCursor={searchResults.next_cursor} />
          </div> 
      </div>

      <div className={styles.resultsList}>
        {searchResults.groups.map((group, index) => (
          <SiteResults
            key={group.uri}
            anchorId={anchors[index]}
            siteUrl={group.uri}
            records={group.responses.map((response) => ({
              recordId: response.warc_custom_id,
              warcRecordId: response.warc_custom_id,
              lastModified: response.last_modified || response.archived_date,
              dateArchived: response.archived_date,
              status: response.status,
              size: 0, // Size not available in current API response
            }))}
          />
        ))}
      </div>

      <Pagination query={query} page={page} totalPages={totalPages} contentType={contentType} nextCursor={searchResults.next_cursor} />
    </div>
  )
}
