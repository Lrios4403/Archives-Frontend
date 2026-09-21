import Link from "next/link";
import Window from "@/components/Window/Window";
import styles from "@/components/Prose/Prose.module.css";

/*
 * The #about pane: what the viewer is, what it opens, how to use it, what it
 * does with your files, and the questions people actually type into a search
 * box before they land here.
 *
 * Written for a reader, and only for a reader. Google's guidance on helpful
 * content is explicit that a page should not promise what it does not deliver,
 * so every capability stated below is one the code has: the accepted formats
 * are components/Offline/fileUpload.tsx's ACCEPTED_EXTENSIONS, the gzip and
 * WACZ behaviour is backend/parser/gzip.ts and wacz.ts, the thread arithmetic
 * is the form's own hints, the record filters are recordListingTree's, and the
 * save behaviour is download.ts. Change those, change this.
 *
 * The headings are phrased as the things people search for — "how to open a
 * WARC file", "view large WARC files without uploading" — rather than as
 * internal section names ("What this page does"). That is not keyword
 * stuffing: each heading introduces a section that answers that question and
 * nothing else, which is the difference between a page organised around its
 * readers and one organised around a term.
 *
 * Styles come from components/Prose, shared with /about, /warcs and /guides.
 *
 * Server component. Nothing here is interactive, and the point of it is to be
 * in the HTML a crawler receives — the same words a person reads.
 */

const GoBack = () => (
    <p className={styles.backRow}>
        <a href="#viewer" className={styles.goBack}>← Go Back</a>
    </p>
);

export default function OfflineGuide() {
    return (
        <>
            <GoBack />

            <Window title="About this WARC viewer" icon="📖">
                <div className={styles.body}>
                    <div className={styles.grid}>
                        <section className={`${styles.card} ${styles.wide}`} aria-labelledby="guide-what">
                            <h2 id="guide-what" className={styles.h2}>Open WARC files online</h2>
                            <div className={styles.twoUp}>
                                <p>
                                    A WARC (Web ARChive) file is the standard container for a web crawl: every request
                                    and response, with its headers and payload, stored as it crossed the wire. It is the
                                    format behind the Internet Archive&apos;s Wayback Machine, what{" "}
                                    <code>wget --warc-file</code> writes, and what Webrecorder&apos;s tools package into
                                    WACZ. Opening one has usually meant installing command-line tooling or uploading the
                                    file to someone else&apos;s server.
                                </p>
                                <p>
                                    This page is an online WARC viewer that runs in your browser. Choose one or more
                                    archives and they are parsed on your own machine into a list of every URL they
                                    captured, grouped by site. Click a capture to see the page replayed from its
                                    captured response, follow its redirect chain, and read the raw HTTP headers. If you
                                    have a <code>.warc</code>, <code>.warc.gz</code> or <code>.wacz</code> and want to
                                    see what is inside it — with no account, upload or install — this is the tool.
                                </p>
                            </div>
                        </section>

                        <section className={`${styles.card} ${styles.wide}`} aria-labelledby="guide-formats">
                            <h2 id="guide-formats" className={styles.h2}>Supported web archive formats</h2>
                            <dl className={styles.formats}>
                                <div className={styles.format}>
                                    <dt>.warc</dt>
                                    <dd>
                                        Plain WARC 1.0 and 1.1. A large file (over 128 MB) is cut into 64 MB pieces and
                                        parsed by several threads at once.
                                    </dd>
                                </div>
                                <div className={styles.format}>
                                    <dt>.warc.gz</dt>
                                    <dd>
                                        Record-compressed WARC — one gzip member per record, which is what wget,
                                        Browsertrix and most crawlers write by default. It is read member by member, so
                                        there is nothing to decompress first. A compressed file is parsed by one thread.
                                    </dd>
                                </div>
                                <div className={styles.format}>
                                    <dt>.wacz</dt>
                                    <dd>
                                        Web Archive Collection Zipped, Webrecorder&apos;s package format (ArchiveWeb.page,
                                        Browsertrix). The <code>.warc.gz</code> archives inside are read straight out of
                                        the zip; nothing is extracted, and a container is listed as one row per archive
                                        it holds. A <code>.wacz.zip</code> — how some browsers rename the download — works
                                        the same way.
                                    </dd>
                                </div>
                            </dl>
                            <p className={styles.note}>
                                <strong>Not supported:</strong> the older <code>.arc</code> format, and a{" "}
                                <code>.wacz</code> whose archives were re-compressed (deflated) inside the zip rather
                                than stored — which the usual tools do not do.
                            </p>
                        </section>

                        <section className={styles.card} aria-labelledby="guide-how">
                            <h2 id="guide-how" className={styles.h2}>How to open a WARC file here</h2>
                            <ol className={styles.steps}>
                                <li>
                                    In <strong>Load archives</strong>, choose your <code>.warc</code>,{" "}
                                    <code>.warc.gz</code> or <code>.wacz</code> files. Several at once is fine.
                                </li>
                                <li>
                                    Leave <strong>Parse threads</strong> alone unless you are opening a very large plain{" "}
                                    <code>.warc</code> — the form says how many threads the selected files can actually
                                    use.
                                </li>
                                <li>
                                    Press <strong>Process Locally</strong>. Each file shows its own progress.
                                </li>
                                <li>
                                    Open <strong>Records</strong>: every captured URL, grouped by origin. Click one to view
                                    it in the frame at the top of the page, where the address bar has back and forward and
                                    a trail of the captures you have visited.
                                </li>
                                <li>
                                    Use the save button on a page to download it as a <code>.zip</code>.
                                </li>
                            </ol>
                            <p style={{ marginTop: 12 }}>
                                Working outside the browser?{" "}
                                <Link href="/guides/how-to-open-warc-file">
                                    How to open a WARC file
                                </Link>{" "}
                                covers the Python and command-line routes too.
                            </p>
                        </section>

                        <section className={styles.card} aria-labelledby="guide-large">
                            <h2 id="guide-large" className={styles.h2}>View large WARC files without uploading them</h2>
                            <p>
                                The archive is read as a stream rather than loaded whole, so multi-gigabyte files work.
                                Nothing is sent anywhere: the file is opened from disk by the browser and parsed in Web
                                Workers on your machine, which is why there is no size cap and no queue.
                            </p>
                            <p>
                                A plain <code>.warc</code> over 128 MB is split into 64 MB ranges and shared between
                                threads. A compressed archive is read by one thread, because gzip members have to be
                                inflated in order.
                            </p>
                        </section>

                        <section className={styles.card} aria-labelledby="guide-browse">
                            <h2 id="guide-browse" className={styles.h2}>Browse the pages inside a WARC</h2>
                            <p>
                                <strong>Records</strong> lists every captured URL grouped by origin, filterable by URL
                                segment and by content type — HTML, images, CSS, JavaScript, fonts and the rest.
                            </p>
                            <p>
                                Opening one replays it from the captured response, with its own address bar, back and
                                forward, a trail of where you have been, and the original HTTP response headers. Links
                                between captured pages work; redirect chains are followed, and a redirect that carries a
                                page of its own is shown rather than skipped.
                            </p>
                        </section>

                        <section className={styles.card} aria-labelledby="guide-privacy">
                            <h2 id="guide-privacy" className={styles.h2}>Privacy — your archive stays on your computer</h2>
                            <p>
                                Parsing runs in Web Workers inside your browser. <strong>Archive contents never leave
                                your browser and are never sent to this server.</strong> There is no upload step, no
                                account, and no size limit imposed by us.
                            </p>
                            <p>
                                The only thing fetched over the network is the parser itself — a few hundred kilobytes of
                                code served by this site, cached after the first visit. It is the same parser that
                                indexes this archive&apos;s own collection, so the browser and the server read a WARC
                                identically.
                            </p>
                        </section>

                        <section className={styles.card} aria-labelledby="guide-limits">
                            <h2 id="guide-limits" className={styles.h2}>Limitations</h2>
                            <ul className={styles.list}>
                                <li>
                                    Archives stream, but the list of records is held in memory — so a file with millions
                                    of records is bounded by RAM even though its bytes are not.
                                </li>
                                <li>
                                    A compressed archive is parsed by one thread. A large <code>.warc.gz</code> takes as
                                    long as one core needs to inflate it; the same data as a plain <code>.warc</code> can
                                    be split across threads.
                                </li>
                                <li>
                                    Replay is a reconstruction, not a time machine. A page renders from what was
                                    captured, so anything the crawl missed — a font, a script, an image, an API the page
                                    called at runtime — is missing here too, and a modern browser may lay out an old page
                                    differently than the browser of the day did.
                                </li>
                                <li>
                                    Saving a page as a <code>.zip</code> writes straight to disk in Chromium browsers.
                                    Elsewhere the zip is built in memory first, which is fine for a page and its assets
                                    but not for gigabytes.
                                </li>
                                <li>Built for current desktop browsers — Chrome, Edge and Firefox.</li>
                            </ul>
                        </section>

                        <section className={styles.card} aria-labelledby="guide-who">
                            <h2 id="guide-who" className={styles.h2}>Who made this, and why</h2>
                            <p>
                                <Link href="/about">M4cgyvers Archives</Link> is a personal web archive: crawls of forums,
                                personal sites and small communities, stored as WARC and indexed so they can be
                                searched. The viewer exists because checking a fresh crawl should not need a server
                                round-trip, and because opening a WARC should not mean uploading it anywhere. It runs the
                                archive&apos;s own parser — one codebase for the server and the browser — so what you see
                                here is what the archive sees.
                            </p>
                        </section>
                    </div>
                </div>
            </Window>

            <Window title="WARC, WACZ and WARC.GZ — common questions" icon="❓">
                <div className={styles.body}>
                    <div className={styles.faqGrid} role="list" aria-label="Frequently asked questions">
                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>What is a WARC file?</h3>
                            <p>
                                WARC (Web ARChive, ISO 28500) stores the raw traffic of a crawl. Each record holds one
                                request, response or metadata block with its own headers, so a page and every image,
                                script and stylesheet it loaded are kept as the server sent them. The Wayback
                                Machine, national libraries and wget all write it; the specification is maintained by
                                the{" "}
                                <a href="https://iipc.github.io/warc-specifications/" rel="noopener noreferrer">
                                    IIPC
                                </a>
                                .
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>Can I open a WARC file online?</h3>
                            <p>
                                Yes — this page is one way. Worth checking on any tool that offers it: some upload your
                                archive to a server and cap the size. Here the file is read locally, so there is no cap
                                and nothing to upload.
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>What is the difference between .warc and .warc.gz?</h3>
                            <p>
                                Same content. In <code>.warc.gz</code> each record is its own gzip member, so a reader
                                can jump to any record without inflating the rest of the file. Nearly every crawler
                                writes <code>.warc.gz</code> by default. Both open here without you decompressing
                                anything.
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>What is a WACZ file?</h3>
                            <p>
                                WACZ (Web Archive Collection Zipped) is{" "}
                                <a href="https://specs.webrecorder.net/wacz/latest/" rel="noopener noreferrer">
                                    Webrecorder&apos;s package format
                                </a>
                                : a zip holding one or more <code>.warc.gz</code> archives plus an index and a list of
                                pages. It is what the ArchiveWeb.page extension saves and what Browsertrix Crawler
                                produces. Open it here like any other archive; each <code>.warc.gz</code> inside is
                                listed on its own.
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>Do I have to upload my file to view it?</h3>
                            <p>
                                No. It is parsed on your machine, and nothing leaves your browser except the request for
                                the parser code.
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>Can I open a WARC file without Python?</h3>
                            <p>
                                Yes — that is what this page is for. No Python, no <code>warcio</code>, no account.
                                Choose the file, press Process Locally, and browse.
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>Can I search inside a WARC file?</h3>
                            <p>
                                You can filter the record list by URL segment and by content type, which is usually how
                                you find one page in a large crawl. Full-text search of page contents is not part of the
                                viewer.
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>Can I open very large WARC files?</h3>
                            <p>
                                Yes. Archives are streamed rather than loaded whole, and there is no upload step to
                                impose a limit. What grows with the archive is the record list held in memory, not the
                                bytes.
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>How do I make a WARC file?</h3>
                            <p>
                                On the command line,{" "}
                                <code>wget --mirror --page-requisites --warc-file=site https://example.com/</code>{" "}
                                writes <code>site.warc.gz</code> as it crawls (see the{" "}
                                <a href="https://www.gnu.org/software/wget/manual/wget.html" rel="noopener noreferrer">
                                    wget manual
                                </a>
                                ). In a browser, the{" "}
                                <a href="https://archiveweb.page/" rel="noopener noreferrer">
                                    ArchiveWeb.page
                                </a>{" "}
                                extension records the pages you visit and saves a <code>.wacz</code>. For whole sites,
                                Browsertrix Crawler produces <code>.wacz</code> too. This archive&apos;s own collection
                                is crawled with wget.
                            </p>
                        </section>

                        <section className={styles.card} role="listitem">
                            <h3 className={styles.h3}>Can I view a website that has gone offline?</h3>
                            <p>
                                If you have an archive of it, yes: pick the file and browse it here. If you do not,{" "}
                                <Link href="/warcs/search">search the M4cgyvers web archive</Link> — over 1,700 WARC
                                files and more than 11 million captured responses — and view captures from there.
                            </p>
                        </section>

                        <section className={`${styles.card} ${styles.wide}`} role="listitem">
                            <h3 className={styles.h3}>Why is it called the offline viewer?</h3>
                            <p>
                                Because your files stay offline. The page is online — it is a website — but what you
                                open never leaves your computer, and that is the property that matters. See also{" "}
                                <Link href="/guides/how-to-open-warc-file">how to open a WARC file</Link> for the
                                non-browser options.
                            </p>
                        </section>
                    </div>
                </div>
            </Window>

            <GoBack />
        </>
    );
}
