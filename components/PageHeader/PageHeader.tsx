import styles from "./PageHeader.module.css"

interface PageHeaderProps {
  title: string
  subtitle?: string
  /** Retro terminal "path" shown beneath the header. */
  eyebrow?: string,
  noDirectory?: boolean
}

// Shared page header used across pages (index, search, browse, ...) so headers
// match. Presentational only, so it works in both Server and Client components.
export default function PageHeader({ title, subtitle, eyebrow = "C:\\ARCHIVES", noDirectory }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>
        {title}
        <span className={styles.cursor} aria-hidden="true">
          _
        </span>
      </h1>

      {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}

      <div className={styles.divider} aria-hidden="true" />

      {/* Terminal path sits UNDER the header text, on its own line. */}
        {!noDirectory && (
      <div className={styles.prompt}>
          <span className={styles.promptPath}>{eyebrow}</span>
        <span className={styles.promptCaret} aria-hidden="true">
          &gt;_
        </span>
      </div>
        )}
    </header>
  )
}
