"use client"

import type React from "react"
import { createContext, useContext, useMemo } from "react"
import { useRouter } from "next/navigation"
import type { WarcRecord } from "@/lib/db"
import { dayKeyOf } from "./timeline"
import styles from "./TimelineWidget.module.css"

// Default behavior (search page): smoothly scroll the matching record to the
// CENTER of the viewport and briefly flash it, instead of the default anchor jump
// (which lands it at the top, often under the fixed nav).
function jumpToRecord(recordId: string) {
  const el = document.getElementById(`record-${recordId}`)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  el.classList.remove("record-flash")
  void el.offsetWidth // restart the animation on repeat clicks
  el.classList.add("record-flash")
  window.setTimeout(() => el.classList.remove("record-flash"), 1600)
}

// Shared with the day bars so we don't prop-drill through year/month.
interface TimelineCtxValue {
  hrefFor: (record: WarcRecord) => string
  select: (record: WarcRecord, dayRecords: WarcRecord[]) => void
  viewLinks: boolean
  activeRecordId?: string
}
const TimelineCtx = createContext<TimelineCtxValue>({
  hrefFor: () => "#",
  select: () => {},
  viewLinks: false,
})

interface TimelineWidgetProps {
  records: WarcRecord[]
  /** When true, clicking a bar opens that capture in /warcs/view instead of scrolling. */
  viewLinks?: boolean
  /** Highlights the bar whose day contains this record id (e.g. the capture being viewed). */
  activeRecordId?: string

  /** Header text. Only worth changing when the timeline is embedded in something that already says "Timeline". */
  title?: string

  /**
   * Where a bar points. Defaults to /warcs/view for viewLinks and to an
   * in-page #record-… anchor otherwise.
   *
   * Overridable because those two defaults both assume the record is IN THE
   * DATABASE. The offline viewer's records live in a File the user picked, have
   * no row to link to, and no element on the page to scroll to — so a caller
   * has to be able to replace this rather than work around it.
   */
  viewHref?: (record: WarcRecord) => string

  /**
   * What a bar click does, replacing navigate-or-scroll. Given the clicked day's
   * whole record list as well, since a day can hold several captures and a
   * caller may want to act on all of them.
   */
  onSelect?: (record: WarcRecord, dayRecords: WarcRecord[]) => void

  /**
   * When either download prop is given, a Download control appears in the
   * header, scoped to every record in this timeline. Absent by default, which is
   * why search and the viewer look exactly as they did.
   */
  onDownload?: (records: WarcRecord[]) => void
  downloadHref?: string
}

// ---------------------------------------------------------------------------
// Derivation
//
// Grouping is done ONCE, here, rather than re-derived at each level of the
// chart. The year row used to group by month, each month row group by day, and
// each day bar parse its record's date again for the number to display — five
// `new Date(...)` calls per record, plus a `toISOString().split("T")` allocating
// two strings each time, all to produce a nesting that was already known.
//
// It also settles a mismatch. The day KEY came from toISOString(), which is UTC,
// while the day NUMBER came from getDate() and the month and year keys from
// getFullYear()/getMonth(), which are local. A capture at 02:34Z sat under the
// key "…-10-03" on a bar labelled "02". Everything below is local, because
// everything DISPLAYED was already local and a reader thinks in their own dates.
// ---------------------------------------------------------------------------

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value))


const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "short" })
const RANGE_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" })

interface DayGroup {
  /** Local YYYY-MM-DD. */
  key: string
  records: WarcRecord[]
}

interface MonthGroup {
  /** Local YYYY-MM. */
  key: string
  label: string
  days: DayGroup[]
}

interface YearGroup {
  key: string
  label: string
  months: MonthGroup[]
}

interface TimelineGroups {
  years: YearGroup[]
  dayCount: number
  maxCount: number
  /** Earliest and latest local day keys, or null when there are no records. */
  span: { first: string; last: string } | null
}

const groupRecords = (records: WarcRecord[]): TimelineGroups => {
  // One parse per record. Insertion order does not matter: keys are sorted below.
  const byDay = new Map<string, WarcRecord[]>()

  for (const record of records) {
    const key = dayKeyOf(record.dateArchived)

    const bucket = byDay.get(key)
    if (bucket) bucket.push(record)
    else byDay.set(key, [record])
  }

  const dayKeys = Array.from(byDay.keys()).sort()

  // reduce, not Math.max(...array). Spreading a large array into a call is a
  // RangeError once it passes the engine's argument limit, and "number of
  // distinct capture days" is not a quantity this component gets to bound.
  const maxCount = dayKeys.reduce((most, key) => Math.max(most, byDay.get(key)!.length), 0)

  const years: YearGroup[] = []

  for (const key of dayKeys) {
    const yearKey = key.slice(0, 4)
    const monthKey = key.slice(0, 7)

    let year = years[years.length - 1]
    if (!year || year.key !== yearKey) {
      year = { key: yearKey, label: yearKey.slice(-2), months: [] }
      years.push(year)
    }

    let month = year.months[year.months.length - 1]
    if (!month || month.key !== monthKey) {
      month = {
        key: monthKey,
        // Noon, so the label cannot slip a month on a timezone offset the way
        // `new Date(monthKey + "-01")` — parsed as UTC midnight — could.
        label: MONTH_LABEL.format(new Date(Number(yearKey), Number(monthKey.slice(5, 7)) - 1, 1, 12)),
        days: [],
      }
      year.months.push(month)
    }

    month.days.push({ key, records: byDay.get(key)! })
  }

  return {
    years,
    dayCount: dayKeys.length,
    maxCount,
    span: dayKeys.length > 0 ? { first: dayKeys[0], last: dayKeys[dayKeys.length - 1] } : null,
  }
}

/** "2026-08-14" -> "Aug 26", without reparsing through the Date string parser. */
const monthYearLabel = (dayKey: string) =>
  RANGE_LABEL.format(new Date(Number(dayKey.slice(0, 4)), Number(dayKey.slice(5, 7)) - 1, 1, 12))

interface WarcTimelineWidgetYearProps {
  year: YearGroup
  maxCount: number
}

interface WarcTimelineMonthProps {
  month: MonthGroup
  maxCount: number
}

interface WarcTimelineDayProps {
  day: DayGroup
  maxCount: number
}

const WarcTimelineDay = ({ day, maxCount }: WarcTimelineDayProps) => {
  const { hrefFor, select, viewLinks, activeRecordId } = useContext(TimelineCtx)
  const records = day.records
  const count = records.length
  const record = records[0]
  const height = maxCount > 0 ? (count / maxCount) * 100 : 0
  // Straight off the group key, which is where the number came from anyway — no
  // second parse, and it can no longer disagree with the bucket it sits in.
  const dayNumber = day.key.slice(-2)
  const isActive = activeRecordId ? records.some((r) => r.recordId === activeRecordId) : false
  const href = hrefFor(record)

  return (
    <div className={styles.dayContainer}>
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          select(record, records)
        }}
        className={`${styles.bar}${isActive ? " " + styles.barActive : ""}`}
        style={
          {
            "--bar-height": `${Math.max(height, 4)}%`,
            backgroundColor: count > 0 ? "var(--accent-orange)" : "var(--text-muted)",
          } as React.CSSProperties
        }
        title={`${day.key}: ${count} record${count === 1 ? "" : "s"}`}
        aria-label={`${viewLinks ? "View" : "Jump to"} records from ${day.key} (${count})`}
        aria-current={isActive ? "true" : undefined}
      />
      <div className={styles.dayNumber}>{dayNumber}</div>
    </div>
  )
}

const WarcTimelineMonth = ({ month, maxCount }: WarcTimelineMonthProps) => (
  <div className={styles.monthContainer}>
    <div className={styles.daysRow}>
      {month.days.map((day) => (
        <WarcTimelineDay key={day.key} day={day} maxCount={maxCount} />
      ))}
    </div>
    <div className={styles.monthLabel}>{month.label}</div>
  </div>
)

const WarcTimelineWidgetYear = ({ year, maxCount }: WarcTimelineWidgetYearProps) => (
  <div className={styles.yearContainer}>
    <div className={styles.monthsRow}>
      {year.months.map((month) => (
        <WarcTimelineMonth key={month.key} month={month} maxCount={maxCount} />
      ))}
    </div>
    <div className={styles.yearLabel}>{year.label}</div>
  </div>
)

export default function TimelineWidget({
  records,
  viewLinks = false,
  activeRecordId,
  title = "Timeline",
  viewHref,
  onSelect,
  onDownload,
  downloadHref,
}: TimelineWidgetProps) {
  const router = useRouter()

  // Before the early return: hooks cannot sit after a conditional exit.
  const groups = useMemo(() => groupRecords(records), [records])

  if (records.length === 0) return null

  // Each override falls back to exactly what this component did before it had
  // any, so an existing call site is unaffected by their presence.
  const hrefFor = (record: WarcRecord) =>
    viewHref
      ? viewHref(record)
      : viewLinks
        ? `/warcs/view?id=${encodeURIComponent(record.recordId)}`
        : `#record-${record.recordId}`

  const select = (record: WarcRecord, dayRecords: WarcRecord[]) => {
    if (onSelect) onSelect(record, dayRecords)
    else if (viewLinks) router.push(`/warcs/view?id=${encodeURIComponent(record.recordId)}`)
    else jumpToRecord(record.recordId)
  }

  const canDownload = Boolean(onDownload || downloadHref)

  const { years, dayCount, maxCount, span } = groups
  const totalRecords = records.length
  const dateRange = span ? `${monthYearLabel(span.first)} - ${monthYearLabel(span.last)}` : ""

  return (
    <TimelineCtx.Provider value={{ hrefFor, select, viewLinks, activeRecordId }}>
      <div className={styles.timelineWidget}>
        <div className={styles.timelineHeader}>
          <h4 className={styles.timelineTitle}>
            <span>📊</span>
            {title}
          </h4>
          <div className={styles.timelineStats}>
            <span className={styles.timelineStat}>{dayCount} days</span>
            <span className={styles.timelineStat}>{totalRecords} records</span>
            <span className={styles.timelineStat}>Peak: {maxCount}</span>
            {canDownload && (
              <a
                className={styles.timelineStat}
                href={downloadHref ?? "#"}
                onClick={(e) => {
                  if (!onDownload) return
                  // Only swallow the click when there is a handler to run in its
                  // place; a caller that gave only downloadHref wants the browser
                  // to follow it normally.
                  e.preventDefault()
                  onDownload(records)
                }}
                aria-label={`Download all ${totalRecords} records in this timeline`}
              >
                📥 Download
              </a>
            )}
          </div>
        </div>

        <div className={styles.timelineChart}>
          <div className={styles.timelineContainer}>
            {years.map((year) => (
              <WarcTimelineWidgetYear key={year.key} year={year} maxCount={maxCount} />
            ))}
          </div>

          <div className={styles.chartLegend}>
            <div className={styles.legendItem}>
              <div className={styles.legendColor} style={{ backgroundColor: "var(--accent-orange)" }} />
              <span>Activity (click to {viewLinks ? "view" : "jump"})</span>
            </div>
            <div className={styles.legendItem}>
              <span className={styles.dateRange}>{dateRange}</span>
            </div>
          </div>
        </div>
      </div>
    </TimelineCtx.Provider>
  )
}
