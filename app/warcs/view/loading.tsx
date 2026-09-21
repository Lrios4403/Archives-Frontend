import Window from "@/components/Window/Window"
import { SkeletonBar, SkeletonRegion } from "@/components/Skeleton/Skeleton"
import styles from "./page.module.css"

export default function ViewArchiveLoading() {
  return (
    <div className={styles.container}>
      <SkeletonRegion label="Loading archived page">
        <div className={styles.mainContent}>
          <Window title="Archived page" icon="VIEW">
            <div style={{ display: "grid", gap: "0.75rem", padding: "1rem" }}>
              <SkeletonBar width="55%" height="1rem" />
              <SkeletonBar width="35%" height="0.75rem" />
              <SkeletonBar width="100%" height="18rem" />
            </div>
          </Window>
          <Window title="Capture history" icon="◷">
            <div style={{ display: "grid", gap: "0.65rem", padding: "1rem" }}>
              <SkeletonBar width="45%" height="0.75rem" />
              <SkeletonBar width="80%" height="0.75rem" />
              <SkeletonBar width="65%" height="0.75rem" />
            </div>
          </Window>
        </div>
      </SkeletonRegion>
    </div>
  )
}
