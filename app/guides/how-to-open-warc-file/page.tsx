import Link from "next/link"
import type { Metadata } from "next"
import Window from "@/components/Window/Window"
import PageHeader from "@/components/PageHeader/PageHeader"
import { pageMetadata } from "@/lib/site"
import { breadcrumbSchema, howToOpenWarcSchema, jsonLd } from "@/lib/schema"
import prose from "@/components/Prose/Prose.module.css"
import styles from "./page.module.css"

/*
 * "How do I open a WARC file" is the question behind most of the searches this
 * site could serve, and it is an INFORMATIONAL one. Answering it on the viewer
 * page would mean one page trying to rank for both "warc viewer" (someone who
 * wants a tool) and "how to open a warc file" (someone who wants to be told
 * what their options are), which is how a page ends up ranking for neither.
 *
 * So it lives here, and it is honest: four methods, including two that are not
 * this site. A page that says "use ours, it is the best" is worth nothing to a
 * reader who is trying to decide, and Google's helpful-content guidance is
 * explicit that content made mainly to attract search visits is the thing it is
 * trying not to reward. Recommending pywb for a serious replay job and saying
 * so plainly is what makes the recommendation of the viewer credible.
 *
 * Everything on this page is server-rendered. No part of the explanation waits
 * on JavaScript.
 */
export const metadata: Metadata = pageMetadata({
  title: "How to Open a WARC File — Browser, Python and Command Line",
  description:
    "Four ways to open a .warc, .warc.gz or .wacz file: in the browser with no install, with ReplayWeb.page, with Python and warcio, or from the command line. What each is good for.",
  path: "/guides/how-to-open-warc-file",
  keywords: [
    "how to open a WARC file",
    "open .warc",
    "WARC file opener",
    "view WARC file",
    "warcio",
    "open warc.gz",
  ],
})

export default function HowToOpenWarcFilePage() {
  return (
    <div className={styles.container}>
      <div className={styles.mainContent}>
        <PageHeader
          title="How to open a WARC file"
          subtitle="Four ways to read a .warc, .warc.gz or .wacz — in the browser, with Python, or from the command line"
          eyebrow="C:\ARCHIVES\GUIDES"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLd(
              breadcrumbSchema([
                { name: "M4cgyvers Archives", path: "/" },
                { name: "Web Archive", path: "/warcs" },
                { name: "How to open a WARC file", path: "/guides/how-to-open-warc-file" },
              ]),
              howToOpenWarcSchema(),
            ),
          }}
        />

        {/*
          * Every Window below opens with a real <h2>.
          *
          * A Window's titlebar is a <span>: it looks like a section heading and
          * is not one, so the first version of this page went h1 -> h3 with
          * nothing in between. That is a broken outline for a screen reader
          * walking the document by heading, and it hides the page's structure
          * from anything that reads headings to work out what an article covers.
          * The titlebar names the section; the h2 states the question it
          * answers, so the two complement rather than repeat each other.
          */}
        <Window title="Background" icon="📄">
          <div className={prose.body}>
            <div className={prose.column}>
              <section className={prose.card}>
                <h2 className={prose.h2}>What a WARC file actually is</h2>
                <p>
                  A WARC file is not a document you open the way you open a PDF. It is a{" "}
                  <strong>recording of network traffic</strong>: a concatenation of records, each holding
                  one HTTP request or response with its headers and body, exactly as it crossed the wire.
                  One WARC can hold a single page or an entire site, with every image, stylesheet and
                  script stored alongside the HTML.
                </p>
                <p>
                  That is why double-clicking one does nothing useful, and why unzipping it is usually
                  the wrong instinct. What you want is a <em>reader</em> that understands records — either
                  to browse the captures, or to replay the pages as they were served.
                </p>
                <p>
                  You will meet three extensions. They are the same content in different wrappers:
                </p>
                <dl className={prose.formats}>
                  <div className={prose.format}>
                    <dt>.warc</dt>
                    <dd>Uncompressed. Records one after another, readable as plain bytes.</dd>
                  </div>
                  <div className={prose.format}>
                    <dt>.warc.gz</dt>
                    <dd>
                      Each record gzipped on its own, then concatenated — so a reader can jump straight
                      to one record without inflating the rest. Most crawlers write this.
                    </dd>
                  </div>
                  <div className={prose.format}>
                    <dt>.wacz</dt>
                    <dd>
                      A ZIP holding one or more <code>.warc.gz</code> archives plus an index. Produced by
                      Webrecorder tools.
                    </dd>
                  </div>
                </dl>
                <p className={prose.note}>
                  <strong>Do not rename a <code>.warc.gz</code> to <code>.gz</code> and decompress it.</strong>{" "}
                  It will often appear to work and give you one valid record followed by silence, because
                  most gzip tools stop at the end of the first member. Use a reader that understands
                  record-level compression.
                </p>
              </section>
            </div>
          </div>
        </Window>

        <Window title="Method 1" icon="🌐">
          <div className={prose.body}>
            <div className={prose.column}>
              <section className={prose.card}>
                <h2 className={prose.h2}>Open a WARC file in your browser, with no install</h2>
                <p>
                  <strong>Best for:</strong> checking what is inside an archive, reading a few pages,
                  inspecting response headers, or working on a machine where you cannot install anything.
                </p>
                <p>
                  The <Link href="/warcs/offline">M4cgyvers WARC viewer</Link> opens{" "}
                  <code>.warc</code>, <code>.warc.gz</code> and <code>.wacz</code> files directly in the
                  browser. Choose the file, press Process Locally, and you get every captured URL grouped
                  by site, with any page replayable from its captured response.
                </p>
                <p>
                  Parsing runs in Web Workers on your own machine and the archive is read as a stream, so
                  multi-gigabyte files do not have to fit in memory. The file is not uploaded.
                </p>
                <ol className={prose.steps}>
                  <li>Open the <Link href="/warcs/offline">WARC viewer</Link>.</li>
                  <li>Choose your archive files under <strong>Load archives</strong>.</li>
                  <li>Press <strong>Process Locally</strong> and wait for the progress bar.</li>
                  <li>Open <strong>Records</strong> and click any capture to view it.</li>
                </ol>
                <p className={prose.chipRow}>
                  <Link href="/warcs/offline" className={prose.chip}>Open a WARC file →</Link>
                </p>
              </section>

              <section className={prose.card}>
                <h3 className={prose.h3}>ReplayWeb.page</h3>
                <p>
                  <a href="https://replayweb.page/" rel="noopener noreferrer">ReplayWeb.page</a>, by
                  Webrecorder, is the other browser-based option and also runs locally. It is built
                  around high-fidelity <em>replay</em> — browsing an archived site as a site — and is the
                  reference implementation for WACZ. If your goal is to navigate a captured site rather
                  than inspect its records, try it.
                </p>
              </section>
            </div>
          </div>
        </Window>

        <Window title="Method 2" icon="🐍">
          <div className={prose.body}>
            <div className={prose.column}>
              <section className={prose.card}>
                <h2 className={prose.h2}>Open a WARC file with Python and warcio</h2>
                <p>
                  <strong>Best for:</strong> extracting data, scripting, filtering a large archive, or
                  anything you need to repeat.
                </p>
                <p>
                  <a href="https://github.com/webrecorder/warcio" rel="noopener noreferrer">warcio</a> is
                  the standard Python library. It streams records, so archive size is not a constraint,
                  and it reads <code>.warc</code> and <code>.warc.gz</code> without a separate
                  decompression step.
                </p>
                <pre className={prose.pre}>{`pip install warcio

# List every captured URL and its status code
python - <<'PY'
from warcio.archiveiterator import ArchiveIterator

with open("archive.warc.gz", "rb") as stream:
    for record in ArchiveIterator(stream):
        if record.rec_type == "response":
            url = record.rec_headers.get_header("WARC-Target-URI")
            status = record.http_headers.get_statuscode()
            print(status, url)
PY`}</pre>
                <p>
                  There is also a command-line side to it — <code>warcio index</code> and{" "}
                  <code>warcio check</code> are useful for a quick look at an archive&apos;s contents and
                  for verifying it is not truncated.
                </p>
              </section>

              <section className={prose.card}>
                <h3 className={prose.h3}>pywb, when you want a real replay server</h3>
                <p>
                  <a href="https://github.com/webrecorder/pywb" rel="noopener noreferrer">pywb</a> is the
                  replay system behind several large archives. It indexes your WARCs and serves them as a
                  local Wayback-style site, which is what you want for a collection you will browse
                  repeatedly rather than inspect once.
                </p>
                <pre className={prose.pre}>{`pip install pywb
wb-manager init mycollection
wb-manager add mycollection archive.warc.gz
wayback          # then open http://localhost:8080/`}</pre>
              </section>
            </div>
          </div>
        </Window>

        <Window title="Method 3" icon="⌨️">
          <div className={prose.body}>
            <div className={prose.column}>
              <section className={prose.card}>
                <h2 className={prose.h2}>Read a WARC file from the command line</h2>
                <p>
                  <strong>Best for:</strong> a quick look, or confirming a file is what you think it is.
                </p>
                <p>
                  An uncompressed <code>.warc</code> is plain text at the record boundaries, so the
                  ordinary tools work:
                </p>
                <pre className={prose.pre}>{`# The first few record headers
head -c 2000 archive.warc

# Every captured URL
grep -a '^WARC-Target-URI:' archive.warc

# How many response records
grep -ac '^WARC-Type: response' archive.warc`}</pre>
                <p>
                  For a <code>.warc.gz</code>, <code>zcat</code> will decompress the whole stream — which
                  works for reading, but throws away the per-record structure that makes random access
                  possible:
                </p>
                <pre className={prose.pre}>{`zcat archive.warc.gz | grep -a '^WARC-Target-URI:' | head`}</pre>
                <p>
                  A <code>.wacz</code> is a ZIP, so <code>unzip -l archive.wacz</code> will list the
                  <code> .warc.gz</code> archives inside it.
                </p>
              </section>
            </div>
          </div>
        </Window>

        <Window title="Comparison" icon="🧭">
          <div className={prose.body}>
            <div className={prose.column}>
              <section className={prose.card}>
                <h2 className={prose.h2}>Which method should you use?</h2>
                <div className={prose.tableWrap}>
                  <table className={prose.table}>
                    <thead>
                      <tr>
                        <th>If you want to…</th>
                        <th>Use</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>See what is inside an archive, quickly</td>
                        <td><Link href="/warcs/offline">WARC viewer</Link> (browser)</td>
                      </tr>
                      <tr>
                        <td>Read the HTTP headers of a capture</td>
                        <td><Link href="/warcs/offline">WARC viewer</Link> (browser)</td>
                      </tr>
                      <tr>
                        <td>Browse a captured site like a site</td>
                        <td>ReplayWeb.page, or pywb</td>
                      </tr>
                      <tr>
                        <td>Extract files or data in bulk</td>
                        <td>Python + warcio</td>
                      </tr>
                      <tr>
                        <td>Serve a collection to other people</td>
                        <td>pywb</td>
                      </tr>
                      <tr>
                        <td>Confirm a file is a valid WARC</td>
                        <td><code>warcio check</code></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>
        </Window>

        <Window title="Questions" icon="❓">
          <div className={prose.body}>
            <h2 className={prose.h2} style={{ marginBottom: 14 }}>Common problems and questions</h2>
            <div className={prose.faqGrid}>
              <section className={prose.card}>
                <h3 className={prose.h3}>Can I open a WARC file online?</h3>
                <p>
                  Yes. The <Link href="/warcs/offline">WARC viewer</Link> and ReplayWeb.page both run in
                  the browser. Note the distinction worth checking on any such tool: both of these parse
                  the file locally, whereas some “online WARC viewer” sites upload your archive to their
                  server and cap the size.
                </p>
              </section>

              <section className={prose.card}>
                <h3 className={prose.h3}>Do I need to extract a .warc.gz first?</h3>
                <p>
                  No, and you should not. Every tool above reads it compressed. Decompressing it by hand
                  usually yields only the first record.
                </p>
              </section>

              <section className={prose.card}>
                <h3 className={prose.h3}>My WARC only shows one page</h3>
                <p>
                  Usually the record-compression problem above, or a crawl that captured a single page.
                  Run <code>warcio check</code>, or open it in the viewer, which reports how many records
                  it found.
                </p>
              </section>

              <section className={prose.card}>
                <h3 className={prose.h3}>Can I open a WARC file without Python?</h3>
                <p>
                  Yes — the browser tools need nothing installed at all. Python is only needed for
                  scripted extraction.
                </p>
              </section>

              <section className={prose.card}>
                <h3 className={prose.h3}>Can Chrome open a WARC file?</h3>
                <p>
                  Not by itself. Chrome has no WARC support; it will download or show raw bytes. A
                  browser-based viewer is JavaScript doing the parsing, not the browser.
                </p>
              </section>

              <section className={prose.card}>
                <h3 className={prose.h3}>How do I make a WARC file?</h3>
                <p>
                  <code>wget --mirror --page-requisites --warc-file=site https://example.com/</code>{" "}
                  writes <code>site.warc.gz</code> as it crawls. In a browser, the{" "}
                  <a href="https://archiveweb.page/" rel="noopener noreferrer">ArchiveWeb.page</a>{" "}
                  extension records what you visit and saves a <code>.wacz</code>.
                </p>
              </section>
            </div>

            <p className={prose.chipRow} style={{ marginTop: 14 }}>
              <Link href="/warcs/offline" className={prose.chip}>Open a WARC file →</Link>
              <Link href="/warcs" className={prose.chip}>Web archive →</Link>
            </p>
          </div>
        </Window>
      </div>
    </div>
  )
}
