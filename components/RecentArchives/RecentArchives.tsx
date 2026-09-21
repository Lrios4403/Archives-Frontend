import { cacheLife, cacheTag } from "next/cache"
import { DEGRADED_CACHE_LIFE, getLatestArchivedReal } from "@/lib/db"
import Unavailable from "@/components/Unavailable/Unavailable"
import ArchiveList from "./ArchiveList"
import ArchiveStatusBar from "./ArchiveStatusBar"
import RecentArchivesClient from "./RecentArchivesClient"

/*
 * Server component, and the ONE place that asks whether the archive answered.
 *
 * It used to hand two async children to the client shell and let each of them
 * fetch and decide for itself. That put the decision in the wrong place: the
 * shell drew its "Recently Archived Sites" window unconditionally, and when the
 * backend was down ArchiveList answered with the Unavailable panel - which has
 * a window of its own - so the reader got a window inside a window, titled
 * twice. Seen live on the VPS with the backend off: both titles in the markup,
 * one nested in the other.
 *
 * Deciding here means the failure notice IS the panel. Nothing is drawn around
 * it, so there is nothing for it to nest inside. The children are now
 * presentational and receive the rows; they no longer fetch.
 *
 * One fetch, one cache entry, deliberately. Three "use cache" components on the
 * same tag agree almost all of the time, but they are three entries that expire
 * on three clocks, and the moment one refreshed while another was stale the
 * list and its count would disagree - or the nested window would be back. A
 * single reading cannot disagree with itself.
 *
 * Cached (not merely async) for the same reason ArchiveList was: an uncached
 * component doing the awaiting gives the prerender nothing it is allowed to
 * finish, and the rows arrive by stream behind a skeleton. Cached, they ship in
 * the first byte of HTML.
 */
/*
 * `async`, and it has to be: the directive is enforced at compile time with
 * "use cache" functions must be async functions, and dropping the keyword
 * while converting this to a promise chain turned the homepage into a 500.
 * Being async and not awaiting are independent — the body below returns a
 * promise rather than awaiting one, which is the point.
 */
export default async function RecentArchives() {
  "use cache"
  cacheTag("archives")

  /*
   * The lifetime is decided AFTER the reading, and this component has to make
   * that decision itself rather than inherit it.
   *
   * When one "use cache" scope encloses another, the OUTER explicit lifetime
   * wins (use-cache-wrapper: `explicitRevalidate !== undefined ?
   * explicitRevalidate : innerCacheStore.revalidate`). So the short degraded
   * lifetime getLatestArchivedReal sets on its failure path is silently
   * discarded here unless this scope agrees. Editing only the data function
   * would have looked correct and done nothing at all — which is the kind of
   * bug that survives review.
   *
   * A .then chain rather than await: the cache store is AsyncLocalStorage, so
   * the continuation runs inside this same "use cache" scope and cacheLife is
   * legal in it.
   */
  return getLatestArchivedReal(8).then(({ archives, unavailable, stale, savedAt }) => {
    /*
     * Two calls in two branches, not one call with a ternary. cacheLife is
     * overloaded (a profile name OR a config object) and an overloaded
     * signature will not accept a union argument, so the ternary form does not
     * typecheck. Branching is also the shape the conditional-lifetime docs use.
     */
    if (stale || unavailable) cacheLife(DEGRADED_CACHE_LIFE)
    else cacheLife("minutes")

    if (unavailable) {
      return <Unavailable info={unavailable} title="Recent Archives Unavailable" />
    }

    /*
     * A client component cannot render an async server component directly (Next
     * 16 throws "is an async Client Component"), but it CAN render one passed in
     * as a prop - the element is rendered here, on the server, and handed over as
     * a node. That is why these go in as props rather than being imported by the
     * shell.
     *
     * `stale` reaches the status bar rather than being dropped here: rows from a
     * snapshot are real rows and worth showing, but showing them as though they
     * were a live reading is the one thing lib/snapshot.ts must not be used to
     * do.
     */
    return (
      <RecentArchivesClient
        list={<ArchiveList archives={archives} />}
        statusBar={
          <ArchiveStatusBar count={archives.length} stale={stale} savedAt={savedAt} />
        }
      />
    )
  })
}
