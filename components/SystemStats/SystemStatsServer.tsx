import { cacheLife, cacheTag } from "next/cache"
import { DEGRADED_CACHE_LIFE, getWarcStatusReal, formatBytes } from "@/lib/db"
import styles from "./SystemStats.module.css"

export function SystemStatsLoading() {
  return (
    <div className={styles.statusBar}>
      <div className={styles.statusContent}>
        <span className={styles.statusLeft}>Loading system stats...</span>
        <div className={styles.statusRight}>
          <div className={styles.statusStat}>
            <span>⏳</span>
            <span>Loading...</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default async function SystemStatsServer() {
  // The footer's file count and total size. Cached at the UI level for the same
  // reason as ArchiveList — see the note there.
  "use cache"
  cacheTag("archives")

  /*
   * Three states now, not two, and the middle one is the whole point of the
   * snapshot work: the backend did not answer, but a previous reading is on
   * disk, so there are real numbers to show provided we say how old they are.
   *
   * A .then chain rather than await — and the lifetime is chosen inside it,
   * because the outer "use cache" scope's explicit lifetime overrides whatever
   * getWarcStatusReal set on its own failure path. Setting it unconditionally
   * up here would have silently discarded the short degraded lifetime.
   */
  return getWarcStatusReal().then((status) => {
    if (status.stale) cacheLife(DEGRADED_CACHE_LIFE)
    else if (status.status === "error") cacheLife(DEGRADED_CACHE_LIFE)
    else cacheLife("minutes")

    // Nothing was reachable and nothing was remembered.
    if (status.status === "error" && !status.stale) {
      return (
        <div className={styles.statusBar}>
          <div className={styles.statusContent}>
            <span className={styles.statusLeft}>System Error</span>
            <div className={styles.statusRight}>
              <div className={styles.statusStat}>
                <span>⚠️</span>
                <span>{status.message ?? "Backend unavailable"}</span>
              </div>
            </div>
          </div>
        </div>
      )
    }

    /*
     * `savedAt` for a snapshot, `date` for a live reading — deliberately, since
     * the two mean different things and the label changes with them. A stale
     * footer says "Last reading" and dates it; it must never present remembered
     * numbers as current ones.
     */
    const stamp = status.stale ? status.savedAt ?? status.date : status.date

    return (
      <div className={styles.statusBar}>
        <div className={styles.statusContent}>
          <span className={styles.statusLeft}>
            {status.stale ? "Last Reading" : "System Ready"}
          </span>
          <div className={styles.statusRight}>
            {status.stale && (
              <div className={styles.statusStat}>
                <span>⚠️</span>
                <span>Archive not responding</span>
              </div>
            )}
            <div className={styles.statusStat}>
              <span>📁</span>
              <span>{status.files.toLocaleString()} Files</span>
            </div>
            <div className={styles.statusStat}>
              <span>💾</span>
              <span>{formatBytes(status.total_bytes)} Total</span>
            </div>
            <div className={styles.statusStat}>
              <span>🕒</span>
              <span>{new Date(stamp).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      </div>
    )
  })
}
