import Link from "next/link"
import type { Metadata } from "next"
import Window from "@/components/Window/Window"
import PageHeader from "@/components/PageHeader/PageHeader"
import { getWarcStatusReal } from "@/lib/db"
import { pageMetadata } from "@/lib/site"
import { breadcrumbSchema, jsonLd } from "@/lib/schema"
import prose from "@/components/Prose/Prose.module.css"
import styles from "./page.module.css"

/*
 * The /warcs hub, which also did not exist — /warcs returned 404 while both of
 * its children (/warcs/offline, /warcs/search) were live.
 *
 * Two reasons to have it. A breadcrumb that reads Home > Web Archive > WARC
 * Viewer has to have something at the middle step, or it is pointing a reader
 * (and a crawler) at a 404. And the two tools genuinely need a page that says
 * which is which: "search what this archive captured" and "open a file of your
 * own" are different jobs that people routinely arrive looking for the wrong
 * one of.
 *
 * Deliberately short. It is a junction, not an article — the substance lives on
 * the two tool pages and in /guides.
 */
export const metadata: Metadata = pageMetadata({
  title: "Web Archive — Search Captures or Open a WARC File",
  description:
    "Search the M4cgyvers web archive, or open your own .warc, .warc.gz and .wacz files in the browser with the free WARC viewer.",
  path: "/warcs",
  keywords: ["web archive", "WARC tools", "open WARC file"],
})

export default async function WarcsHubPage() {
  const status = await getWarcStatusReal()
  // Live or remembered, both are worth stating — see the note in app/about.
  const hasNumbers = status.files > 0
  /*
   * Surfaced, not swallowed. WarcStatus.stale exists precisely so a snapshot
   * cannot be rendered as a live fact, and this page was the one consumer that
   * read the numbers and ignored the flag — stating a remembered file count as
   * though the archive had just answered.
   */
  const asOf = status.stale && status.savedAt ? new Date(status.savedAt) : null

  return (
    <div className={styles.container}>
      <div className={styles.mainContent}>
        <PageHeader
          title="Web Archive"
          subtitle="Search what this archive has captured, or open a WARC file of your own"
          eyebrow="C:\ARCHIVES\WARCS"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLd(
              breadcrumbSchema([
                { name: "M4cgyvers Archives", path: "/" },
                { name: "Web Archive", path: "/warcs" },
              ]),
            ),
          }}
        />

        <Window title="Two tools" icon="🗄️">
          <div className={prose.body}>
            <div className={prose.grid}>
              <section className={prose.card}>
                <h2 className={prose.h2}>Open a WARC file</h2>
                <p>
                  The <Link href="/warcs/offline">WARC viewer</Link> opens <code>.warc</code>,{" "}
                  <code>.warc.gz</code> and <code>.wacz</code> files from your own computer. Parsing
                  happens in your browser — the file is not uploaded — and you get every captured URL,
                  the pages replayed as captured, and the raw HTTP response headers.
                </p>
                <p>
                  Use this when you have an archive file and want to see what is inside it.
                </p>
                <p className={prose.chipRow}>
                  <Link href="/warcs/offline" className={prose.chip}>Open a WARC file →</Link>
                </p>
              </section>

              <section className={prose.card}>
                <h2 className={prose.h2}>Search this archive</h2>
                <p>
                  <Link href="/warcs/search">Archive search</Link> covers everything captured here
                  {hasNumbers ? ` — ${status.files.toLocaleString()} WARC files` : ""}
                  {asOf ? ` as of ${asOf.toLocaleDateString()}` : ""}. Search by URL or
                  hostname, filter by content type, and open any capture in the viewer.
                </p>
                <p>Use this when you are looking for a site rather than reading a file you already have.</p>
                <p className={prose.chipRow}>
                  <Link href="/warcs/search" className={prose.chip}>Search the archive →</Link>
                </p>
              </section>

              <section className={`${prose.card} ${prose.wide}`}>
                <h2 className={prose.h2}>Guides</h2>
                <p>
                  Background on the formats, and how to work with them outside this site:{" "}
                  <Link href="/guides/how-to-open-warc-file">how to open a WARC file</Link> covers the
                  browser, Python and command-line routes, and what each is good for.
                </p>
              </section>
            </div>
          </div>
        </Window>
      </div>
    </div>
  )
}
