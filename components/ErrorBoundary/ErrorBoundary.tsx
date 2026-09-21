"use client"

import React from "react"
import Window from "@/components/Window/Window"
import Button from "@/components/Button/Button"
import styles from "./ErrorBoundary.module.css"

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ComponentType<ErrorFallbackProps>
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}

interface ErrorFallbackProps {
  error: Error
  resetError: () => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  resetError = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const FallbackComponent = this.props.fallback || DefaultErrorFallback
      return <FallbackComponent error={this.state.error!} resetError={this.resetError} />
    }

    return this.props.children
  }
}

/*
 * What to actually say to a reader.
 *
 * `error.message` alone produced this, verbatim, on a search page whose only
 * problem was that the backend was switched off:
 *
 *   "Minified React error #441; visit https://react.dev/errors/441 for the full
 *    message or use the non-minified dev environment for full errors..."
 *
 * That is React telling us it has withheld the real message — #441 is
 * literally "An error occurred in the Server Components render. The specific
 * message is omitted in production builds to avoid leaking sensitive details."
 * Printing it at a reader shows them the encoding of an error instead of the
 * error, and instructs them to go rebuild the app in development.
 *
 * So: recognise the withheld-message cases and say something true about them.
 * The raw text stays available under Technical Details for whoever wants it.
 */
function explain(error: Error & { digest?: string }): string {
  const message = error?.message ?? ""

  if (/Minified React error #(441|418|419|422|423)/.test(message) || error?.digest) {
    return (
      "The server hit an error while rendering this section. React hides the "
      + "details in a production build, so the specific cause is only in the "
      + "server logs."
    )
  }

  if (/\bfetch failed\b|NetworkError|Failed to fetch|ECONNREFUSED/i.test(message)) {
    return "Couldn't reach the archive backend. It may be restarting - try again in a moment."
  }

  if (/HTTP error! status:\s*5\d{2}/.test(message)) {
    return "The archive backend returned an error. This is usually temporary."
  }

  return message || "An unexpected error occurred."
}

function DefaultErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const digest = (error as Error & { digest?: string })?.digest

  return (
    <Window title="System Error" icon="⚠️">
      <div className={styles.errorContainer}>
        <div className={styles.errorIcon}>💥</div>
        <h2 className={styles.errorTitle}>Something went wrong</h2>
        <p className={styles.errorMessage}>{explain(error)}</p>
        {/*
          * The digest is the ONLY thing tying this screen to a line in the
          * server log, precisely because React withheld the message. Shown
          * rather than buried: it costs a reader nothing and it is the first
          * thing worth asking for in a bug report.
          */}
        {digest && (
          <p className={styles.errorMessage}>
            <small>Reference: <code>{digest}</code></small>
          </p>
        )}
        <div className={styles.errorDetails}>
          <details className={styles.errorDetailsToggle}>
            <summary>Technical Details</summary>
            <pre className={styles.errorStack}>{error.stack || "No stack trace available"}</pre>
          </details>
        </div>
        <div className={styles.errorActions}>
          <Button onClick={resetError}>🔄 Try Again</Button>
          <Button onClick={() => window.location.reload()} className={styles.reloadButton}>
            🔃 Reload Page
          </Button>
        </div>
      </div>
    </Window>
  )
}

export default ErrorBoundary
