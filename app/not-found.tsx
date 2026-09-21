import Link from "next/link"
import Navigation from "@/components/Navigation/Navigation"
import Window from "@/components/Window/Window"
import Button from "@/components/Button/Button"
import LocalTimestamp from "@/components/LocalTimestamp/LocalTimestamp"
import styles from "./not-found.module.css"

export default function NotFound() {
  return (
    <>
      <Navigation />

      <div className={styles.container}>
        <div className={styles.mainContent}>
          <div className={styles.errorWindow}>
            <Window title="System Error - 404" icon="⚠️">
              <div className={styles.errorContent}>
                <div className={styles.errorIcon}>
                  <div className={styles.iconContainer}>
                    <span className={styles.mainIcon}>💥</span>
                    <span className={styles.subIcon}>404</span>
                  </div>
                </div>

                <div className={styles.errorDetails}>
                  <h1 className={styles.errorTitle}>Page Not Found</h1>
                  <p className={styles.errorMessage}>
                    The requested archive or page could not be located in our digital preservation system.
                  </p>

                  <div className={styles.errorInfo}>
                    <div className={styles.infoItem}>
                      <span className={styles.infoLabel}>Error Code:</span>
                      <code className={styles.infoValue}>HTTP 404</code>
                    </div>
                    <div className={styles.infoItem}>
                      <span className={styles.infoLabel}>System Status:</span>
                      <span className={styles.infoValue}>Archive Index Operational</span>
                    </div>
                    <div className={styles.infoItem}>
                      <span className={styles.infoLabel}>Timestamp:</span>
                      <LocalTimestamp className={styles.infoValue} />
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.suggestions}>
                <h3 className={styles.suggestionsTitle}>🔍 Suggested Actions:</h3>
                <ul className={styles.suggestionsList}>
                  <li>Check the URL for typos or missing characters</li>
                  <li>The archive may have been moved or removed</li>
                  <li>Try searching for the content using our search function</li>
                  <li>Browse our available archives from the home page</li>
                </ul>
              </div>

              <div className={styles.actions}>
                <Link href="/">
                  <Button>🏠 Return Home</Button>
                </Link>
                <Link href="/warcs/search">
                  <Button>🔍 Search Archives</Button>
                </Link>
              </div>
            </Window>
          </div>

          <div className={styles.terminalWindow}>
            <Window title="System Log" icon="📟">
              <div className={styles.terminal}>
                <div className={styles.terminalLine}>
                  <span className={styles.prompt}>$</span>
                  <span className={styles.command}>locate requested_page</span>
                </div>
                <div className={styles.terminalLine}>
                  <span className={styles.output}>locate: no entries found</span>
                </div>
                <div className={styles.terminalLine}>
                  <span className={styles.prompt}>$</span>
                  <span className={styles.command}>find /archives -name "*requested*"</span>
                </div>
                <div className={styles.terminalLine}>
                  <span className={styles.output}>find: no matches in archive index</span>
                </div>
                <div className={styles.terminalLine}>
                  <span className={styles.prompt}>$</span>
                  <span className={styles.command}>echo "Suggestion: try homepage"</span>
                </div>
                <div className={styles.terminalLine}>
                  <span className={styles.output}>Suggestion: try homepage</span>
                </div>
                <div className={styles.terminalLine}>
                  <span className={styles.prompt}>$</span>
                  <span className={styles.cursor}>_</span>
                </div>
              </div>
            </Window>
          </div>
        </div>
      </div>
    </>
  )
}
