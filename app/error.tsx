"use client"

import Window from "@/components/Window/Window"
import Button from "@/components/Button/Button"
import styles from "./error.module.css"

/*
 * The route-level error boundary the app did not have.
 *
 * app/ contained only not-found.tsx, so any unexpected server error rendered
 * Next's built-in 500 document — which ships without this site's stylesheet, so
 * a reader got unstyled black-on-white text with no navigation and no way back.
 *
 * Presentation only. It cannot change a status code and it is not a substitute
 * for the failure handling in lib/db.tsx: everything that can be anticipated is
 * already degraded to an Unavailable panel or a snapshot long before it reaches
 * here. This is the floor under the genuinely unexpected.
 *
 * A client component, as the convention requires — it has to be, because
 * `reset` is a callback and the boundary lives in the browser.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  /*
   * `retry`, NOT `reset`, and the difference is the whole value of the button.
   *
   * The installed docs are explicit: "In most cases, you should use retry()
   * instead. However, if you have a specific reason to clear the error state
   * and re-render the error boundary's children WITHOUT re-fetching the
   * contents, you can use reset()." Every error this file exists to catch comes
   * from a server render, so clearing local state without re-fetching would
   * re-render the same failed tree and show the same error immediately — a
   * button that visibly does nothing. `retry` re-fetches and re-renders.
   */
  retry: () => void
}) {
  return (
    <div className={styles.container}>
      <div className={styles.mainContent}>
        <Window title="Something went wrong" icon="💥">
          <div className={styles.body}>
            <p className={styles.lead}>
              This page hit an error it was not expecting. That is a fault here, not
              anything you did.
            </p>

            {/*
              * The digest, not the message. React replaces a server error's text
              * with "Minified React error #…" in production and withholds the
              * real message deliberately; printing it would show the reader a
              * sentence about React's error encoding. The digest is the one
              * thing that actually correlates with the server log.
              */}
            {error.digest ? (
              <p className={styles.digest}>
                Reference: <code>{error.digest}</code>
              </p>
            ) : null}

            <div className={styles.actions}>
              <Button onClick={() => retry()}>Try again</Button>
              <a href="/" className={styles.link}>Back to the archive</a>
              <a href="/warcs/offline" className={styles.link}>Open a WARC file</a>
            </div>

            {/*
              * The offline viewer is worth pointing at from here specifically:
              * it parses files in the browser, so it is the one part of this
              * site that keeps working when the server side does not.
              */}
          </div>
        </Window>
      </div>
    </div>
  )
}
