"use client"

import type { ReactNode } from "react"
import Window from "@/components/Window/Window"
import Button from "@/components/Button/Button"
import ErrorBoundary from "@/components/ErrorBoundary/ErrorBoundary"
import styles from "./RecentArchives.module.css"


function ArchiveListError({ error, resetError }: { error: Error; resetError: () => void }) {
  return (
    <div className={styles.errorContainer}>
      <div className={styles.errorIcon}>⚠️</div>
      <p className={styles.errorMessage}>Failed to load archives</p>
      <p className={styles.errorDetails}>{error.message}</p>
      <Button onClick={resetError} size="small">
        🔄 Retry
      </Button>
    </div>
  )
}


function StatusBarError({ error, resetError }: { error: Error; resetError: () => void }) {
  return (
    <div className={styles.statusBar}>
      <span className={styles.statusLeft}>Error loading status</span>
      <div className={styles.statusRight}>
        <Button size="small" onClick={resetError}>
          🔄 Retry
        </Button>
      </div>
    </div>
  )
}

interface RecentArchivesClientProps {
  // Async server components, rendered on the server and passed in as nodes.
  list: ReactNode
  statusBar: ReactNode
}

// Client shell: provides the Window chrome and the (interactive) error
// fallbacks. It renders the server-rendered `list`/`statusBar` nodes rather than
// importing the async components itself, which keeps them out of the client
// boundary.
export default function RecentArchivesClient({ list, statusBar }: RecentArchivesClientProps) {
  /*
   * No <Suspense> around `list` and `statusBar` any more, and that omission is
   * the whole point of caching them.
   *
   * A Suspense boundary and a cached component ask for opposite things from the
   * prerender. Cache Components puts a cached result INTO the static shell; a
   * Suspense boundary puts its FALLBACK into the shell and streams the content
   * at request time. Wrap one in the other and the boundary wins.
   *
   * That is exactly what this file used to do, and the measurement was
   * unambiguous: with the boundaries here, the delivered markup contained six
   * skeleton rows and zero real ones — the archives existed only in the RSC
   * payload. The page had a 3ms time to first byte and still showed
   * "Loading archive..." to the reader.
   *
   * The docs' own "static, cached, and streaming" example draws the same line:
   * the cached <BlogPosts /> is rendered directly, and only <UserPreferences />,
   * which reads cookies at request time, gets a boundary.
   *
   * The ErrorBoundaries stay. They are about a fetch that FAILS, which is
   * unrelated to when it resolves, and a cached read can still throw.
   */
  return (
    <div className={styles.container}>
      <Window title="Recently Archived Sites" icon="📁">
        <ErrorBoundary fallback={ArchiveListError}>{list}</ErrorBoundary>
        <ErrorBoundary fallback={StatusBarError}>{statusBar}</ErrorBoundary>
      </Window>
    </div>
  )
}
