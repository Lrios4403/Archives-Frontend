import type { WarcLatestResponse } from "@/lib/db"
import ArchiveItemComponent from "./ArchiveItem"
import styles from "./RecentArchives.module.css"

/*
 * Rows, and only rows.
 *
 * This component used to fetch for itself and, when the archive could not be
 * reached, return the Unavailable panel - complete with its own window - from
 * inside the window the client shell had already drawn around it. The fetch
 * and the decision now live one level up in RecentArchives, which either
 * renders the notice as the whole panel or renders this with the rows. There
 * is deliberately no failure branch here: given no rows, this renders an empty
 * list, and it is the caller's job never to hand it that.
 */
export default function ArchiveList({ archives }: { archives: WarcLatestResponse[] }) {
  return (
    <div className={styles.listContainer}>
      {archives.map((archive) => (
        <ArchiveItemComponent key={archive.warc_custom_id} archive={archive} />
      ))}
    </div>
  )
}
