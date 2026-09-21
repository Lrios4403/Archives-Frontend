import Window from "@/components/Window/Window"
import SearchBar from "@/components/Search/SearchBar"
import styles from "./WarcSearchInterface.module.css"

interface WarcSearchInterfaceProps {
  initialQuery?: string
  /** Content types currently stored, for the filter dropdown (excludes "Any"). */
  contentTypes?: string[]
  /** Currently selected content type ("" = Any). */
  initialContentType?: string
  /**
   * Whether a search was actually submitted. Distinct from a non-empty
   * initialQuery: an empty query is a real search (it matches everything), so
   * truthiness of the query cannot be used to decide between showing the current
   * search and showing the tips.
   */
  searched?: boolean
}

// Server component. It used to be a client component reading useSearchParams(),
// which returns null while the shell prerenders — so the current-search line and
// the tips block were both absent on first paint and popped in on hydration.
// Everything it needs already arrives as props from the page, so the markup can
// be produced on the server with the real values.
export default function WarcSearchInterface({
  initialQuery = "",
  contentTypes = [],
  initialContentType = "",
  searched = false,
}: WarcSearchInterfaceProps) {
  // The wrapper below used styles.searchInterface, which was never defined in
  // the module — it rendered class="undefined" and dropped the 4rem bottom
  // margin that separates this window from the results underneath.
  return (
    <div className={styles.searchContainer}>
      <Window title="WARC Search" icon="🔍">
        <div className={styles.searchContent}>
          <SearchBar
            initialQuery={initialQuery}
            initialContentType={initialContentType}
            contentTypes={contentTypes}
            placeholder="Search WARC records... (e.g., myspace.com, geocities.com)"
            autoFocus
          />

          {searched ? (
            <div className={styles.currentSearch}>
              <span className={styles.currentSearchLabel}>Current search:</span>
              <code className={styles.currentSearchQuery}>
                {initialQuery ? `"${initialQuery}"` : "everything"}
              </code>
              {initialContentType && (
                <code className={styles.currentSearchQuery}>type: {initialContentType}</code>
              )}
            </div>
          ) : (
            <div className={styles.searchHints}>
              <h4 className={styles.hintsTitle}>💡 Search Tips:</h4>
              <ul className={styles.hintsList}>
                <li>Try site names: "myspace.com", "geocities.com", "friendster.com"</li>
                <li>Search for specific content: "profile", "blog", "forum"</li>
                <li>Use partial matches: "myspace" will find all MySpace records</li>
                <li>Narrow by type with the dropdown (e.g. text/html, image/png)</li>
                <li>Leave the box empty and hit Search to browse every archive</li>
              </ul>
            </div>
          )}
        </div>
      </Window>
    </div>
  )
}
