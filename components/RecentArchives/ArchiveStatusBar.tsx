import Button from "@/components/Button/Button"
import styles from "./RecentArchives.module.css"

/**
 * When a snapshot was taken, as something a reader can act on.
 *
 * A bare ISO string in a status bar is noise; "3 days ago" is the thing someone
 * actually wants to know when deciding whether to trust what is above it.
 * Deliberately coarse — this is a caveat, not a clock.
 */
const describeAge = (savedAt: string | undefined): string | null => {
  if (!savedAt) return null

  const saved = Date.parse(savedAt)
  if (!Number.isFinite(saved)) return null

  const minutes = Math.max(0, Math.round((Date.now() - saved) / 60_000))
  if (minutes < 60) return minutes <= 1 ? "a moment ago" : `${minutes} minutes ago`

  const hours = Math.round(minutes / 60)
  if (hours < 48) return hours === 1 ? "an hour ago" : `${hours} hours ago`

  return `${Math.round(hours / 24)} days ago`
}

/*
 * The count under the list. Receives the number rather than fetching it, so it
 * is by construction the count of exactly the rows rendered above it - the two
 * came from the same reading.
 *
 * It also carries the staleness caveat. RecentArchives shows the failure notice
 * INSTEAD of this window when the archive could not be reached at all, so the
 * only failure this bar has to describe is the softer one: the backend did not
 * answer, but a previous reading was on disk and those are its rows.
 */
export default function ArchiveStatusBar({
  count,
  stale,
  savedAt,
}: {
  count: number
  /** Rows came from a snapshot rather than a live reading. */
  stale?: true
  /** ISO 8601, when that snapshot was taken. */
  savedAt?: string
}) {
  const age = describeAge(savedAt)

  return (
    <div className={styles.statusBar}>
      <span className={styles.statusLeft}>
        {stale
          ? `${count} archives shown — last reading${age ? ` from ${age}` : ""}, the archive is not responding`
          : `${count} archives shown`}
      </span>
      <div className={styles.statusRight}>
        <Button size="small">View All Archives</Button>
      </div>
    </div>
  )
}
