import Link from "next/link"
import Window from "@/components/Window/Window"
import SharedSearchBar from "@/components/Search/SearchBar"
import { getContentTypesReal } from "@/lib/db"
import { searchHref } from "@/components/WarcSearch/actions"
import styles from "./SearchBar.module.css"

const QUICK_SEARCHES = ["myspace.com", "geocities.com", "friendster.com"]

/*
 * Awaited now, where it used to be handed over unresolved.
 *
 * The old shape was right for an UNCACHED read: awaiting here would have held
 * back the whole front page's HTML, so the promise went to the client search bar
 * unawaited and it unwrapped it with use() inside its own <Suspense>, letting
 * the input and submit button ship in the shell while the dropdown streamed.
 *
 * getContentTypesReal is cached now, so there is nothing left to hold back — it
 * resolves during prerendering and the whole form ships in the static shell.
 *
 * That is not just tidier, it fixes the form. Measured on the running site: the
 * streamed boundary never resolved on the client, so the dropdown sat on its
 * disabled one-option fallback forever, AND the search input, the form and the
 * submit button were all left unhydrated with it — a child that suspends and
 * never resolves takes its parent's hydration down with it. The whole search box
 * was inert, saved only by the plain GET form underneath it.
 */
export default async function SearchBar() {
  const contentTypes = await getContentTypesReal()

  return (
    <div className={styles.searchContainer}>
      <Window title="Search Archives" icon="🔍">
        <div className={styles.searchContent}>
          {/* Standardized search bar, shared with /warcs/search. */}
          <SharedSearchBar placeholder="Enter search terms..." contentTypes={contentTypes} />

          {/* Quick search suggestions */}
          <div className={styles.quickSearches}>
            <p className={styles.quickSearchTitle}>🚀 Quick Searches:</p>
            <div className={styles.quickSearchButtons}>
              {QUICK_SEARCHES.map((term) => (
                <Link
                  key={term}
                  href={searchHref(term)}
                  className={styles.quickSearchButton}
                >
                  {term.replace(/\.com$/, "").replace(/^\w/, (c) => c.toUpperCase())}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </Window>
    </div>
  )
}
