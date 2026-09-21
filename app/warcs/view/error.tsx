"use client"

import Button from "@/components/Button/Button"
import Window from "@/components/Window/Window"
import styles from "./page.module.css"

export default function ViewArchiveError({ retry }: { retry: () => void }) {
  return (
    <div className={styles.container}>
      <div className={styles.mainContent}>
        <Window title="Archive unavailable" icon="VIEW">
          <div style={{ display: "grid", gap: "1rem", padding: "1.25rem" }}>
            <p>We could not load this capture right now. The archive service may be offline or busy.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
              <Button onClick={retry}>Retry loading</Button>
              <a href="/warcs/search">Return to search</a>
            </div>
          </div>
        </Window>
      </div>
    </div>
  )
}
