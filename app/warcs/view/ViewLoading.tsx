import Window from "@/components/Window/Window"
import { SkeletonBar, SkeletonRegion } from "@/components/Skeleton/Skeleton"
import siteStyles from "@/components/WarcSearch/SiteResults.module.css"
import styles from "./page.module.css"

/**
 * Stands in for the archive iframe. Uses the same `flush` window and the same
 * .viewer class, so it reserves the identical 16/9 box (min 480px) and the real
 * iframe drops straight into it.
 */
export function ViewerLoading() {
  return (
    <SkeletonRegion label="Loading archived page">
      <Window title="Loading archive…" icon="🌐" flush>
        <SkeletonBar className={styles.viewer} width="100%" height="auto" />
      </Window>
    </SkeletonRegion>
  )
}

/**
 * Stands in for the SiteResults capture history below the viewer. Deliberately
 * lighter than the search-results skeleton — the history is secondary here, and
 * the viewer above it is what the visitor came for.
 */
export function SiteHistoryLoading() {
  return (
    <SkeletonRegion label="Loading capture history">
      <div className={siteStyles.siteContainer}>
        <Window title="Loading capture history…" icon="🌐">
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
            </div>

            <div className={siteStyles.timelineSection}>
              <SkeletonBar width="100%" height="7rem" />
            </div>
          </div>
        </Window>
      </div>
    </SkeletonRegion>
  )
}
