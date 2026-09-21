import { searchHref } from "./actions"
import styles from "./Pagination.module.css"

// Build the page list: always 1 and last, a window around current, "dots" for gaps.
function pageItems(current: number, total: number): (number | "dots")[] {
  const wanted = new Set<number>([1, total, current, current - 1, current + 1])
  const valid = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)

  const items: (number | "dots")[] = []
  let prev = 0
  for (const p of valid) {
    if (p - prev > 1) items.push("dots")
    items.push(p)
    prev = p
  }
  return items
}

interface PaginationProps {
  page: number
  totalPages: number
  /** The search query these pages belong to. Becomes the path segment. */
  query?: string
  /** Optional content-type filter; carried through as ?content_type=. */
  contentType?: string
  /**
   * Where THIS page ended, if the backend said.
   *
   * Attached to the next-page link and to nothing else. It names a position in
   * the (recursion_level, uri) ordering, not a page, so it is only correct for
   * the page immediately after this one — put it on a jump to page 47 and the
   * reader gets page 2's rows under a "47" label.
   *
   * Following it costs a seek instead of an OFFSET: measured 49-227x cheaper,
   * and flat in depth rather than merely faster. Absent is fine; the link then
   * carries only ?page= and the backend walks the offset as before.
   */
  nextCursor?: { level: number; uri: string } | null
}

export default function Pagination({ page, totalPages, query, contentType, nextCursor }: PaginationProps) {
  if (totalPages <= 1) return null

  // One builder for every search link in the app — see searchHref. `basePath`
  // is gone: the query is a path segment now, so a caller cannot supply the
  // route without also knowing how the slug is formed.
  const href = (p: number) =>
    searchHref(query ?? "", {
      page: p,
      contentType,
      // Strictly the NEXT page — see the prop's note.
      cursor: p === page + 1 ? nextCursor : null,
    })
  const items = pageItems(page, totalPages)

  return (
    <nav className={styles.pagination} aria-label="Pagination">
      {page > 1 && (
        <a href={href(page - 1)} className={styles.pageLink} rel="prev" aria-label="Previous page">
          ‹ Prev
        </a>
      )}

      {items.map((item, i) =>
        item === "dots" ? (
          <span key={`dots-${i}`} className={styles.dots} aria-hidden="true">
            …
          </span>
        ) : (
          <a
            key={item}
            href={href(item)}
            className={item === page ? `${styles.pageLink} ${styles.active}` : styles.pageLink}
            aria-current={item === page ? "page" : undefined}
          >
            {item}
          </a>
        ),
      )}

      {page < totalPages && (
        <a href={href(page + 1)} className={styles.pageLink} rel="next" aria-label="Next page">
          Next ›
        </a>
      )}
    </nav>
  )
}
