import type { Metadata } from "next"
import SiteResults from "@/components/WarcSearch/SiteResults"
import WarcViewer from "@/components/WarcView/Viewer"
import ViewHistoryProvider from "@/components/WarcView/context"
import {
  getNearestCaptureReal,
  getRecordSiteHistoryReal,
  headerOf,
  isRedirect,
  type WarcRecord,
} from "@/lib/db"
import { PUBLIC_API_URL } from "@/lib/api"
import { pageMetadata } from "@/lib/site"
import styles from "./page.module.css"

/*
 * NOINDEX, and this is the one metadata decision here with real consequences.
 *
 * This route renders a captured copy of somebody else's page. Letting it be
 * indexed would put third-party content into search results under THIS domain —
 * duplicate content competing with the original, at the scale of every capture
 * in the corpus (17k records from seven files, and the NAS holds 1,779 more).
 * That is the shape of a scraper, not an archive, and it is the kind of thing
 * that earns a manual action rather than traffic.
 *
 * `follow: true` is kept on purpose: crawlers may still walk the trail between
 * captures, and the search pages that link here stay discoverable. What is
 * withheld is putting the archived body itself in the index.
 *
 * The id also makes every URL unique per capture, so indexing would generate a
 * near-infinite crawl space over content we did not write.
 */
const VIEWER_ROBOTS = { index: false, follow: true } as const

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>
}): Promise<Metadata> {
  const { id } = await searchParams

  /*
   * id is `warcs/<file>.warc::<original-url>::<uuid>`, so the middle segment is
   * the page being viewed. Worth pulling out even on a noindex route: this is
   * the browser tab title and the link preview when someone shares a capture in
   * a chat, and "View Archive" tells the recipient nothing about what they are
   * being sent.
   */
  const originalUrl = id?.split("::")[1]

  if (!originalUrl) {
    return pageMetadata({
      title: "View Archive",
      description: "View an archived web page captured in a WARC file.",
      path: "/warcs/view",
      robots: VIEWER_ROBOTS,
    })
  }

  // Host alone in the title — a full forum URL is ~120 characters and would be
  // truncated to uselessness in a tab or an unfurl.
  let host = originalUrl
  try {
    host = new URL(originalUrl).host
  } catch {
    /* keep the raw string: a malformed id should not break the page */
  }

  return pageMetadata({
    title: `Archived: ${host}`,
    description: `An archived capture of ${originalUrl}, served from a WARC file exactly as it was originally recorded.`,
    path: "/warcs/view",
    keywords: ["archived page", "WARC record", host],
    robots: VIEWER_ROBOTS,
  })
}

/*
 * A blocking route, with no <Suspense> anywhere in it. Both halves of that are
 * load-bearing and neither works alone.
 *
 * Under Cache Components, anything behind a Suspense boundary is POSTPONED: the
 * shell ships with the fallback, the content is streamed afterwards, and — on
 * Next 16.3.2 — that streamed content never hydrates. Measured on this page:
 * every capture rendered correctly and not one button worked, including the
 * timeline's own click handler, which had never fired since the day it was
 * written. Only the layout's nav was live.
 *
 * `instant = false` is what lets the route await request data at the top level
 * instead of hiding it behind a boundary. It costs the instant shell — this page
 * now waits for the history query before it sends anything — and buys a page
 * whose JavaScript runs. For a viewer whose whole purpose is the record list
 * beneath it, that is the right side of the trade.
 *
 * Adding `instant = false` while leaving the boundaries in place does NOTHING:
 * measured at 2 postponed boundaries either way. The boundaries are the cause.
 */
export const instant = false

interface ViewSearchParams {
  id?: string
}

export default async function ViewArchivePage({
  searchParams,
}: {
  searchParams: Promise<ViewSearchParams>
}) {
  const { id } = await searchParams

  if (!id) {
    return (
      <div className={styles.container}>
        <div className={styles.mainContent}>
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>🗄️</div>
            <p className={styles.emptyText}>
              No archive selected. Open this page with an <code>id</code>, e.g.
              <br />
              <code>/warcs/view?id=warcs/5am.warc::https://example.com/::&lt;uuid&gt;</code>
            </p>
          </div>
        </div>
      </div>
    )
  }

  /*
   * The PUBLIC url, because this is handed to <WarcViewer> and ends up as the
   * iframe's src — a request the reader's browser makes, not the server.
   *
   * It also has to stay a DIFFERENT origin from the app: the viewer trusts
   * `warc-navigate` messages by checking event.origin against this value, and
   * an archived page served same-origin would make that check vacuous.
   */
  const apiBase = PUBLIC_API_URL

  // id format: warcs/<file>.warc::<original-url>::<uuid> — pull out the URL for display.
  const originalUrl = id.split("::")[1] ?? id

  const history = await getRecordSiteHistoryReal(id)

  const timelineRecords: WarcRecord[] = history.map((r) => ({
    recordId: r.warc_custom_id,
    warcRecordId: r.warc_custom_id,
    lastModified: r.archived_date,
    dateArchived: r.archived_date,
    status: Number(r.status) || 0,
    size: Number(r.byte_length ?? 0) || 0,
  }))

  /*
   * The capture's own row, picked out of the history we already fetched.
   *
   * The address bar wants its content type and size, and this query has both —
   * so a second lookup for the page being viewed would be a round trip for data
   * already in hand. A capture is always present in its own history; the
   * fallback covers a row that has somehow gone missing between the two.
   */
  const current = history.find((row) => row.warc_custom_id === id)

  /*
   * Where this capture points, when it is a redirect rather than a page.
   *
   * Resolved HERE, on the server, because two things downstream need the
   * destination's id and neither can get it on its own: Save has to target the
   * page rather than the 1,206-byte stub a 301 stores, and the "follow" control
   * has to route somewhere. Doing it in the browser would mean the reader sees a
   * blank frame first and the answer arrives afterwards.
   *
   * A redirect whose destination is not archived resolves to null, which is a
   * real answer — the viewer says so rather than offering a dead control.
   */
  const status = Number(current?.status) || 0
  const location = isRedirect(status) ? headerOf(current?.headers, "location") : undefined

  const destinationUrl = location
    ? (() => {
        try {
          // Relative Location headers are legal and common.
          return new URL(location, current?.uri ?? originalUrl).href
        } catch {
          return undefined
        }
      })()
    : undefined

  const destination = destinationUrl
    ? await getNearestCaptureReal(destinationUrl, current?.archived_date)
    : null

  return (
    /*
     * The provider wraps BOTH the viewer and the capture list, not just the
     * viewer.
     *
     * The trail is page state, not viewer state. The list below the frame is the
     * other way into a capture — clicking View there is a navigation exactly like
     * clicking a link inside the frame — and it will want to read the trail to
     * mark the rows already visited. Scoping the provider to the viewer would put
     * the history somewhere the list cannot reach and guarantee a second copy
     * later.
     */
    <ViewHistoryProvider>
      <div className={styles.container}>
        <div className={styles.mainContent}>
          <WarcViewer
            apiBase={apiBase}
            record={{
              id,
              url: current?.uri ?? originalUrl,
              contentType: current?.content_type ?? null,
              size: current?.byte_length ?? null,
              archivedDate: current?.archived_date,
              status,
              redirect: destinationUrl
                ? {
                    to: destinationUrl,
                    // Null when the destination was never captured. The viewer
                    // reports that rather than offering a control that goes
                    // nowhere.
                    id: destination?.warc_custom_id ?? null,
                  }
                : null,
            }}
          />

          {/* Same single window as search: timeline on top, full record listings
              below. Each record's "View" opens that capture above. */}
          {timelineRecords.length > 0 && (
            <SiteResults siteUrl={originalUrl} records={timelineRecords} />
          )}
        </div>
      </div>
    </ViewHistoryProvider>
  )
}
