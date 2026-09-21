import Window from "@/components/Window/Window"
import { SkeletonBar, SkeletonRegion } from "@/components/Skeleton/Skeleton"
import styles from "./WarcSearchResults.module.css"
import siteStyles from "./SiteResults.module.css"
import recordStyles from "./WarcRecordItem.module.css"

// How many placeholder sites/records to draw. Two sites with three records each
// is roughly a screenful — enough to fill the space without pretending we know
// how many results are coming.
const SITES = 2
const RECORDS_PER_SITE = 3

function RecordSkeleton() {
  return (
    <div className={recordStyles.recordCard}>
      <header className={recordStyles.recordHeader}>
        <div className={recordStyles.recordTitle}>
          <span className={recordStyles.recordIcon} aria-hidden="true">
            📄
          </span>
          <div className={recordStyles.recordInfo}>
            <div className={recordStyles.recordId}>
              <SkeletonBar width="20rem" height="0.85rem" />
            </div>
            <div className={recordStyles.recordType}>
              <SkeletonBar width="4rem" height="0.7rem" />
            </div>
          </div>
        </div>
        <SkeletonBar width="3rem" height="1.4rem" />
      </header>

      <div className={recordStyles.recordBody}>
        <div className={recordStyles.recordGrid}>
          {["🔧", "📅"].map((icon) => (
            <section key={icon} className={recordStyles.recordSection}>
              <h4 className={recordStyles.sectionTitle}>
                <span aria-hidden="true">{icon}</span>
                <SkeletonBar width="5rem" height="0.8rem" />
              </h4>
              <ul className={recordStyles.metaList}>
                {[0, 1].map((i) => (
                  <li key={i} className={recordStyles.metaItem}>
                    <span className={recordStyles.metaLabel}>
                      <SkeletonBar width="3rem" height="0.75rem" />
                    </span>
                    <span className={recordStyles.metaValue}>
                      <SkeletonBar width="7rem" height="0.75rem" />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

function SiteSkeleton() {
  return (
    <div className={siteStyles.siteContainer}>
      <Window title="Loading site…" icon="🌐">
        <div className={siteStyles.siteContent}>
          <div className={siteStyles.siteHeader}>
            <div className={siteStyles.siteInfo}>
              <h3 className={siteStyles.siteTitle}>
                <SkeletonBar width="16rem" height="1.1rem" />
              </h3>
              <div className={siteStyles.siteStats}>
                {["📊", "💾", "📅"].map((icon) => (
                  <div key={icon} className={siteStyles.statItem}>
                    <span aria-hidden="true">{icon}</span>
                    <SkeletonBar width="4.5rem" height="0.8rem" />
                  </div>
                ))}
              </div>
            </div>
            <div className={siteStyles.siteActions}>
              <button className={siteStyles.actionButton} disabled>
                <span aria-hidden="true">📊</span>
                Timeline
              </button>
              <button className={siteStyles.actionButton} disabled>
                <span aria-hidden="true">📥</span>
                Download
              </button>
            </div>
          </div>

          {/* Stands in for TimelineWidget, which is roughly this tall. */}
          <div className={siteStyles.timelineSection}>
            <SkeletonBar width="100%" height="7rem" />
          </div>

          <div className={siteStyles.recordsList}>
            {Array.from({ length: RECORDS_PER_SITE }).map((_, i) => (
              <RecordSkeleton key={i} />
            ))}
          </div>
        </div>
      </Window>
    </div>
  )
}

/**
 * Suspense fallback for WarcSearchResults.
 *
 * Built from WarcSearchResults' / SiteResults' / WarcRecordItem's own CSS
 * modules rather than a bespoke layout, so this and the finished results share
 * the same widths, gaps and window chrome. The previous version was a separate
 * 800px-wide panel with an indeterminate progress bar and invented "Indexing
 * archives → Matching records → Preparing results" steps, so it described work
 * that wasn't happening and then jumped to a completely different layout.
 */
export default function WarcSearchResultsLoading() {
  return (
    <SkeletonRegion label="Searching archives">
      <div className={styles.resultsContainer}>
        <div className={styles.resultsHeader}>
          <div className={styles.resultsSummary}>
            <div className={styles.summaryStats}>
              {["Query:", "Sites:", "Page:"].map((label) => (
                <div key={label} className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>{label}</span>
                  <span className={styles.summaryValue}>
                    <SkeletonBar width="4rem" height="0.85rem" />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.resultsList}>
          {Array.from({ length: SITES }).map((_, i) => (
            <SiteSkeleton key={i} />
          ))}
        </div>
      </div>
    </SkeletonRegion>
  )
}
