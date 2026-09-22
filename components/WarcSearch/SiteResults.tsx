import { memo } from "react"
import type { WarcRecord } from "@/lib/db"
import Window from "@/components/Window/Window"
import WarcRecordItem from "./WarcRecordItem"
import TimelineWidget from "./TimelineWidget"
import { bulkDownloadHref, bulkDownloadName } from "./actions"
import styles from "./SiteResults.module.css"

interface SiteResultsProps {
  siteUrl: string
  records: WarcRecord[]
  /**
   * The id the results page's jump list scrolls to.
   *
   * Passed in rather than derived here, because uniqueness is a property of the
   * whole page and this component only sees one site. See siteAnchors.
   */
  anchorId?: string
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return value < 10 ? value.toFixed(1) + sizes[i] : Math.round(value) + sizes[i]
}

function SiteResults({ siteUrl, records, anchorId }: SiteResultsProps) {
  // One pass, and no spread: `Math.min(...records.map(...))` builds an
  // intermediate array and then passes every element as a separate argument,
  // which throws RangeError once a site has enough captures. A site's record
  // count is not something this component gets to bound.
  const totalSize = records.reduce((sum, record) => sum + record.size, 0)

  let earliest = Number.POSITIVE_INFINITY
  let latest = Number.NEGATIVE_INFINITY

  for (const record of records) {
    const at = new Date(record.dateArchived).getTime()
    if (at < earliest) earliest = at
    if (at > latest) latest = at
  }

  const dateRange = { earliest: new Date(earliest), latest: new Date(latest) }


  /*
   * One zip holding every capture listed here.
   *
   * A plain link, because the route answers with `Content-Disposition:
   * attachment` — so a navigation saves the file instead of replacing the page,
   * and middle-click and "save link as" behave like they do on any other
   * download. No handler, no fetch, and it works with JavaScript disabled.
   *
   * `included` can be short of `records.length`: every id goes in the query
   * string, and Bun answers 431 once the request head passes 16 KiB. The link
   * carries as many as fit and says how many it left, rather than generating a
   * url the server refuses. See bulkDownloadHref.
   */
  const bulk = bulkDownloadHref(records.map((record) => record.recordId))

  return (
    <div className={styles.siteContainer}>
      <Window id={anchorId} className={styles.siteWindow} title={`${siteUrl}`} icon="🌐">
        <div className={styles.siteContent}>
          <div className={styles.siteHeader}>
            <div className={styles.siteInfo}>
              <h3 className={styles.siteTitle}>{siteUrl}</h3>
              <div className={styles.siteStats}>
                <div className={styles.statItem}>
                  <span>📊</span>
                  <span>{records.length} records</span>
                </div>
                <div className={styles.statItem}>
                  <span>💾</span>
                  <span>{formatBytes(totalSize)}</span>
                </div>
                <div className={styles.statItem}>
                  <span>📅</span>
                  <span>
                    {dateRange.earliest.toLocaleDateString("en-US", { month: "short", year: "2-digit" })} -{" "}
                    {dateRange.latest.toLocaleDateString("en-US", { month: "short", year: "2-digit" })}
                  </span>
                </div>
              </div>
            </div>
            <div className={styles.siteActions}>
              <button className={styles.actionButton}>
                <span>📊</span>
                Timeline
              </button>
              <a
                href={bulk.href}
                download={bulkDownloadName(siteUrl)}
                className={styles.actionButton}
                aria-label={
                  bulk.dropped > 0
                    ? `Download the first ${bulk.included} of ${records.length} captures of ${siteUrl} as a zip`
                    : `Download all ${bulk.included} captures of ${siteUrl} as a zip`
                }
                title={
                  bulk.dropped > 0
                    ? `Downloads the first ${bulk.included} captures. ${bulk.dropped} more than the request URL can carry — open them individually.`
                    : "Download every capture listed here, with the resources they reference"
                }
              >
                <span>📥</span>
                {bulk.dropped > 0 ? `Download ${bulk.included}` : "Download"}
              </a>
            </div>
          </div>

          <div className={styles.timelineSection}>
            <TimelineWidget records={records} />
          </div>

          <div className={styles.recordsList}>
            {records.map((record) => (
              <WarcRecordItem key={record.recordId} record={record} />
            ))}
          </div>
        </div>
      </Window>
    </div>
  )
}

export default memo(SiteResults, (previous, next) => {
  if (previous.siteUrl !== next.siteUrl || previous.anchorId !== next.anchorId) return false
  if (previous.records === next.records) return true
  if (previous.records.length !== next.records.length) return false

  // Keep memoization useful when a parent recreates the array but the server
  // returned the same lightweight summaries in the same order.
  return previous.records.every((record, index) => {
    const nextRecord = next.records[index]
    return (
      record === nextRecord ||
      (record.recordId === nextRecord?.recordId &&
        record.status === nextRecord.status &&
        record.dateArchived === nextRecord.dateArchived &&
        record.lastModified === nextRecord.lastModified)
    )
  })
})
