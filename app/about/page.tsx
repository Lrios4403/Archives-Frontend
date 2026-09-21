import Link from "next/link"
import type { Metadata } from "next"
import Window from "@/components/Window/Window"
import PageHeader from "@/components/PageHeader/PageHeader"
import { getWarcStatusReal } from "@/lib/db"
import { pageMetadata } from "@/lib/site"
import { breadcrumbSchema, jsonLd, organizationSchema } from "@/lib/schema"
import prose from "@/components/Prose/Prose.module.css"
import styles from "./page.module.css"

/*
 * The About page, which did not exist.
 *
 * Every page on the site linked to /about from the navigation and /about
 * returned 404 — verified live. That is the worst kind of broken link: it is on
 * every page, so a crawler meets it on every crawl, and it is the page a reader
 * goes to when they want to know whether the tool they just used is run by
 * anybody.
 *
 * Written as an actual account of the project rather than a stub, because the
 * thing it has to answer is "who made this, and can I trust the WARC viewer I
 * just fed a file to". Google's guidance on people-first content asks for
 * exactly that — who, how and why — and it is also simply the honest thing to
 * put behind a link named About.
 */
export const metadata: Metadata = pageMetadata({
  title: "About M4cgyvers Archives",
  description:
    "M4cgyvers Archives is a personal web archive: crawls of forums, personal sites and small communities stored as WARC and indexed so they can be searched and replayed in the browser.",
  path: "/about",
  keywords: ["web archive project", "WARC collection", "digital preservation"],
})

export default function AboutPage() {
  return getWarcStatusReal().then((status) => {
    /*
     * Shown whenever there are numbers, live OR remembered — gating on
     * status === "ok" discarded a perfectly good snapshot and left the page
     * blank during an outage, which was the opposite of the point. What changes
     * between the two cases is whether the figures get dated, not whether they
     * appear. See WarcStatus.stale.
     */
    const hasNumbers = status.files > 0
    const files = hasNumbers ? status.files.toLocaleString() : null
    const terabytes = hasNumbers
      ? (status.total_bytes / 1e12).toFixed(2)
      : null
    const asOf =
      status.stale && status.savedAt
        ? new Date(status.savedAt)
        : null

  return (
    <div className={styles.container}>
      <div className={styles.mainContent}>
        <PageHeader
          title="About M4cgyvers Archives"
          subtitle="A personal web archive, and the tools built to read it"
          eyebrow="C:\ARCHIVES\ABOUT"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLd(
              breadcrumbSchema([
                { name: "M4cgyvers Archives", path: "/" },
                { name: "About", path: "/about" },
              ]),
              organizationSchema(),
            ),
          }}
        />

        <Window title="What this is" icon="ℹ️">
          <div className={prose.body}>
            <div className={prose.grid}>
              <section className={`${prose.card} ${prose.wide}`}>
                {hasNumbers ? (
                  <div className={prose.stats}>
                    <div className={prose.stat}>
                      <span className={prose.statValue}>{files}</span>
                      <span className={prose.statLabel}>
                        WARC files{asOf ? ` · as of ${asOf.toLocaleDateString()}` : ""}
                      </span>
                    </div>
                    <div className={prose.stat}>
                      <span className={prose.statValue}>{terabytes} TB</span>
                      <span className={prose.statLabel}>on disk</span>
                    </div>
                  </div>
                ) : null}

                <div className={prose.twoUp}>
                  <p>
                    M4cgyvers Archives is a personal web-preservation project. It crawls sites that are
                    small, old, or likely to disappear — forums, personal homepages, webring-era
                    communities — and stores exactly what the servers sent, as WARC files.
                  </p>
                  <p>
                    Everything captured is indexed so it can be searched by URL and content type, and
                    replayed as it was captured. The same archive is the reason the{" "}
                    <Link href="/warcs/offline">WARC viewer</Link> exists: a tool for reading a WARC had
                    to be built to check the crawls, and there was no reason not to let it read yours too.
                  </p>
                </div>
              </section>

              <section className={prose.card}>
                <h2 className={prose.h2}>What gets archived</h2>
                <p>
                  Forums and message boards, personal and hobbyist sites, small community hosts such as
                  Neocities and Nekoweb, and a handful of sites reachable only over I2P. The bias is
                  toward places that are not being archived by anyone else and are one hosting bill away
                  from vanishing.
                </p>
                <p>
                  Crawling is done with <code>wget --warc-file</code>, which records every request and
                  response rather than a rendered copy. Nothing is rewritten on the way in.
                </p>
              </section>

              <section className={prose.card}>
                <h2 className={prose.h2}>Why WARC</h2>
                <p>
                  WARC (ISO 28500) is the format national libraries and the Internet Archive use. It
                  stores the raw HTTP exchange — headers, status line and body — so a capture can be
                  replayed later, and inspected rather than merely read.
                </p>
                <p>
                  A directory of saved HTML cannot tell you what the server said; a WARC can. See{" "}
                  <Link href="/guides/how-to-open-warc-file">how to open a WARC file</Link> for what that
                  means in practice.
                </p>
              </section>

              <section className={prose.card}>
                <h2 className={prose.h2}>How it is built</h2>
                <p>
                  A parser written for this archive reads the WARC records and loads them into Postgres,
                  which backs the search index. A small server serves the API; the site itself is a
                  Next.js application.
                </p>
                <p>
                  The interesting part is that the parser is <strong>one codebase</strong>. The same code
                  that indexes the collection on the server is compiled for the browser and runs in the
                  viewer&apos;s Web Workers, so the two cannot disagree about what a WARC record means.
                </p>
              </section>

              <section className={prose.card}>
                <h2 className={prose.h2}>Who runs it</h2>
                <p>
                  One person, as a hobby project. It is not a company, it is not funded, and it has no
                  users to sell — which is most of the reason the viewer parses your files locally
                  instead of asking you to upload them.
                </p>
                <p className={prose.note}>
                  Captures are stored as they were received. Inclusion in this archive is not an
                  endorsement of anything captured, and the archive holds no rights over third-party
                  content — the copyright in a captured page belongs to whoever wrote it.
                </p>
              </section>
            </div>
          </div>
        </Window>

        {/*
          * No Window around these, deliberately.
          *
          * A titlebar with minimise/maximise/close controls over three links is
          * chrome pretending to be content — it announces "Where to go next"
          * and then says it again in the links themselves. They are navigation
          * at the end of a page, so they get to be exactly that: a centered row.
          */}
        <nav className={styles.nextSteps} aria-label="Where to go next">
          <Link href="/warcs/offline" className={prose.chip}>Open a WARC file →</Link>
          <Link href="/warcs/search" className={prose.chip}>Search the archive →</Link>
          <Link href="/guides/how-to-open-warc-file" className={prose.chip}>Guides →</Link>
        </nav>
      </div>
    </div>
  )
  })
}