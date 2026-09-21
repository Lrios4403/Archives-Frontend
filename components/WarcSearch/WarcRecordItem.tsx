"use client"

import { memo, useEffect, useRef, useState } from "react"
import type { WarcRecord } from "@/lib/db"
import { copyText, downloadHref, downloadName, viewHref, viewUrlForClipboard } from "./actions"
import styles from "./WarcRecordItem.module.css"

interface WarcRecordItemProps {
  record: WarcRecord
  isHighlighted?: boolean
}

// Helper function to format bytes compactly
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return value < 10 ? value.toFixed(1) + sizes[i] : Math.round(value) + sizes[i]
}

// Helper function to format date compactly
function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  })
}

// Helper function to get record type from WARC ID
function getRecordType(warcRecordId: string): { icon: string; type: string } {
  const id = warcRecordId.toLowerCase()
  if (id.includes("response")) return { icon: "📄", type: "Response" }
  if (id.includes("request")) return { icon: "📤", type: "Request" }
  if (id.includes("metadata")) return { icon: "📋", type: "Meta" }
  if (id.includes("resource")) return { icon: "📦", type: "Resource" }
  if (id.includes("revisit")) return { icon: "🔄", type: "Revisit" }
  return { icon: "📄", type: "Record" }
}

// Helper function to get status color class
function getStatusColorClass(status: number): string {
  if (status >= 200 && status < 300) return styles.statusSuccess
  if (status >= 300 && status < 400) return styles.statusRedirect
  if (status >= 400 && status < 500) return styles.statusClientError
  if (status >= 500) return styles.statusServerError
  return styles.statusUnknown
}

// Helper function to truncate WARC ID
function truncateWarcId(warcId: string): string {
  if (warcId.length <= 20) return warcId
  return warcId.substring(0, 8) + "..." + warcId.substring(warcId.length - 8)
}

/** What the Copy button is showing. Reverts to "idle" a moment after a click. */
type CopyState = "idle" | "copied" | "failed"

const COPY_LABEL: Record<CopyState, { icon: string; text: string }> = {
  idle: { icon: "📋", text: "Copy" },
  copied: { icon: "✅", text: "Copied" },
  failed: { icon: "⚠️", text: "Failed" },
}

function WarcSearchResultsListItem({ record, isHighlighted = false }: WarcRecordItemProps) {
  const { icon, type } = getRecordType(record.warcRecordId)
  const statusColorClass = getStatusColorClass(record.status)

  const [copyState, setCopyState] = useState<CopyState>("idle")

  /*
   * The revert timer, in a ref rather than an effect keyed on the state.
   *
   * An effect would not restart on a second click while "Copied" is still
   * showing: React bails out when a state is set to the value it already has,
   * so the effect never re-runs and the label reverts on the FIRST click's
   * timer, a second earlier than the reader expects. Owning the handle here
   * means every click cancels the pending revert and starts a new one.
   */
  const revert = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(revert.current), [])

  const onCopy = async () => {
    /*
     * The absolute url is built HERE, not in an attribute.
     *
     * It reads window.location, which does not exist during the server render.
     * In an href or a title it would render one string on the server and another
     * in the browser, and React reports that as a hydration mismatch on every
     * row on the page. In a click handler there is no server render to disagree
     * with.
     */
    const ok = await copyText(viewUrlForClipboard(record.recordId))

    setCopyState(ok ? "copied" : "failed")

    window.clearTimeout(revert.current)
    revert.current = window.setTimeout(() => setCopyState("idle"), 1600)
  }

  return (
    // The :target highlight and its keyframes used to live here, in a <style>
    // element rendered per record — twenty results meant twenty style nodes with
    // byte-identical keyframes, each parsed separately. They are one static rule
    // in styles/universal.css now, matched on the id prefix rather than written
    // out per id, so nothing about them depends on which records are on screen.
    <>
      <article
        id={`record-${record.recordId}`}
        className={`${styles.recordCard} ${isHighlighted ? styles.highlighted : ""}`}
        data-record-id={record.recordId}
        data-record-date={new Date(record.dateArchived).toISOString().split("T")[0]}
        tabIndex={0}
        role="article"
        aria-label={`WARC record ${record.recordId}, status ${record.status}, archived ${formatDate(record.dateArchived)}`}
      >
        <header className={styles.recordHeader}>
          <div className={styles.recordTitle}>
            <span className={styles.recordIcon} aria-hidden="true">
              {icon}
            </span>
            <div className={styles.recordInfo}>
              <div className={styles.recordId}>{record.recordId}</div>
              <div className={styles.recordType}>{type}</div>
            </div>
          </div>
          <div className={`${styles.statusBadge} ${statusColorClass}`} title={`HTTP Status: ${record.status}`}>
            {record.status}
          </div>
        </header>

        <div className={styles.recordBody}>
          <div className={styles.recordGrid}>
            <section className={styles.recordSection}>
              <h4 className={styles.sectionTitle}>
                <span aria-hidden="true">🔧</span>
                Details
              </h4>
              <ul className={styles.metaList}>
                <li className={styles.metaItem}>
                  <span className={styles.metaLabel}>WARC</span>
                  <span className={styles.metaValue} title={record.warcRecordId}>
                    {truncateWarcId(record.warcRecordId)}
                  </span>
                </li>
                <li className={styles.metaItem}>
                  <span className={styles.metaLabel}>Size</span>
                  <span className={styles.metaValue} title={`${record.size} bytes`}>
                    {formatBytes(record.size)}
                  </span>
                </li>
              </ul>
            </section>

            <section className={styles.recordSection}>
              <h4 className={styles.sectionTitle}>
                <span aria-hidden="true">📅</span>
                Dates
              </h4>
              <ul className={styles.timelineList}>
                <li className={styles.timelineItem}>
                  <span className={styles.timelineLabel}>
                    <span aria-hidden="true">📝</span>
                    Modified
                  </span>
                  <time className={styles.timelineValue} dateTime={record.lastModified} title={record.lastModified}>
                    {formatDate(record.lastModified)}
                  </time>
                </li>
                <li className={styles.timelineItem}>
                  <span className={styles.timelineLabel}>
                    <span aria-hidden="true">📦</span>
                    Archived
                  </span>
                  <time className={styles.timelineValue} dateTime={record.dateArchived} title={record.dateArchived}>
                    {formatDate(record.dateArchived)}
                  </time>
                </li>
              </ul>
            </section>
          </div>
        </div>

        <footer className={styles.recordFooter}>
          <a
            href={viewHref(record.recordId)}
            className={styles.actionButton}
            aria-label={`View WARC record ${record.recordId}`}
          >
            <span aria-hidden="true">🔍</span>
            View
          </a>
          {/*
            * A real link now, rather than the `href="#"` placeholder it was.
            *
            * The response is `Content-Disposition: attachment`, so a plain
            * navigation saves the file instead of replacing the page — no click
            * handler, no fetch, and it works with middle-click and "save link as"
            * like any other download.
            */}
          <a
            href={downloadHref(record.recordId)}
            download={downloadName(record.recordId)}
            className={styles.actionButton}
            aria-label={`Download WARC record ${record.recordId} as a zip`}
            title="Download this capture, with the resources it references"
          >
            <span aria-hidden="true">📥</span>
            Download
          </a>
          {/*
            * A button, not an anchor. It navigates nowhere, and the `href="#"`
            * it used to carry meant a middle-click opened a second copy of the
            * page and a plain click jumped to the top of this one.
            */}
          <button
            type="button"
            onClick={() => {
              void onCopy()
            }}
            className={styles.actionButton}
            aria-label={`Copy the viewer link for WARC record ${record.recordId}`}
            title="Copy a link to this capture"
          >
            <span aria-hidden="true">{COPY_LABEL[copyState].icon}</span>
            {/* Announced, because for a copy button the RESULT is the only
                feedback there is: nothing else on the page changes. */}
            <span aria-live="polite">{COPY_LABEL[copyState].text}</span>
          </button>
        </footer>
      </article>
    </>
  )
}

export default memo(
  WarcSearchResultsListItem,
  (previous, next) =>
    previous.isHighlighted === next.isHighlighted &&
    previous.record === next.record,
)
