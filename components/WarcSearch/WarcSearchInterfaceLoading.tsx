import Window from "@/components/Window/Window"
import { SkeletonBar, SkeletonRegion } from "@/components/Skeleton/Skeleton"
import styles from "./WarcSearchInterface.module.css"
// The real interface delegates its input row to the shared Search/SearchBar, so
// the placeholder row has to borrow THAT module's classes. WarcSearchInterface's
// own searchForm/searchInput/... rules are leftovers from before the bar was
// extracted and no longer describe what renders here.
import barStyles from "@/components/Search/SearchBar.module.css"

/**
 * Suspense fallback for WarcSearchInterface.
 *
 * Reuses WarcSearchInterface's own module so the window chrome, padding and the
 * search row's proportions match what replaces it. The row is drawn with
 * placeholders rather than a live SearchBar on purpose: a real input here would
 * be unmounted when the streamed version arrives, throwing away anything typed
 * in the meantime and firing autoFocus twice.
 */
export default function WarcSearchInterfaceLoading() {
  return (
    <SkeletonRegion label="Loading search">
      <div className={styles.searchContainer}>
        <Window title="WARC Search" icon="🔍">
          <div className={styles.searchContent}>
            <div className={barStyles.searchForm}>
              <div className={barStyles.searchInputGroup}>
                <SkeletonBar className={barStyles.searchInput} height="2.25rem" />
                <SkeletonBar className={barStyles.contentTypeSelect} width="9rem" height="2.25rem" />
                <SkeletonBar className={barStyles.searchButton} width="7rem" height="2.25rem" />
              </div>
            </div>

            <div className={styles.searchHints}>
              <h4 className={styles.hintsTitle}>💡 Search Tips:</h4>
              <ul className={styles.hintsList}>
                {["28rem", "22rem", "25rem", "24rem"].map((width) => (
                  <li key={width}>
                    <SkeletonBar width={width} height="0.85rem" />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Window>
      </div>
    </SkeletonRegion>
  )
}
