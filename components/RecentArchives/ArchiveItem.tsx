import styles from "./RecentArchives.module.css"

interface ArchiveItemProps {
  archive: {
    warc_custom_id: string
    uri: string
    archived_date: string
    status: number
    content_type: string | null
  }
}

export default function ArchiveItemComponent({ archive }: ArchiveItemProps) {
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  return (
    <div className={styles.archiveItem}>
      <div className={styles.archiveInfo}>
        <span className={styles.archiveIcon}>🌐</span>
        <div className={styles.archiveDetails}>
          {/* Full URL; .archiveName truncates with an ellipsis on overflow. */}
          <div className={styles.archiveName} title={archive.uri}>
            {archive.uri}
          </div>
          <div className={styles.archiveDate}>Archived: {formatDate(archive.archived_date)}</div>
        </div>
      </div>
      <div className={styles.archiveStats}>
        <div className={styles.archiveSize}>Status: {archive.status}</div>
        <a
          href={`/warcs/view?id=${encodeURIComponent(archive.warc_custom_id)}`}
          className={styles.archiveLink}
        >
          View Archive
        </a>
      </div>
    </div>
  )
}
