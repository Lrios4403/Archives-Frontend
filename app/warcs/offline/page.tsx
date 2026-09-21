import { preconnect } from "react-dom";
import type { Metadata } from "next";
import Window from "@/components/Window/Window";
import WarcOfflineFileUploadForm from "@/components/Offline/fileUpload";
import WarcOfflineIFrameViewer from "@/components/Offline/iframe";
import OfflineContextProvider from "@/components/Offline/provider";
import OfflineTools from "@/components/WebMCP/OfflineTools";
import WarcOfflineRecordListingTree from "@/components/Offline/recordListingTree";
import WarcOfflineViewTimeline from "@/components/Offline/viewTimeline";
import { WarcOfflineFileCount, WarcOfflineRecordCount } from "@/components/Offline/windowCounts";
import OfflineGuide from "@/components/Offline/OfflineGuide";
import { PUBLIC_API_URL } from "@/lib/api";
import { pageMetadata } from "@/lib/site";
import { breadcrumbSchema, jsonLd, warcViewerSchema } from "@/lib/schema";
import styles from "./page.module.css";

/*
 * The one page here with a genuine search audience: people looking for a way to
 * view a .warc, .warc.gz or .wacz file without installing anything. The words
 * below are the words they type.
 *
 * It used to lead with "Offline". Measured on the live page: the title and the
 * h1 both opened with the word, "online" appeared zero times, .wacz was absent
 * from the description, and beyond one sentence of subtitle there was no text at
 * all — an app shell. To someone searching "view warc files online", a result
 * titled "Offline WARC Viewer" reads as the opposite of what they asked for,
 * and a page with no prose gives Search nothing to match the question against.
 *
 * "Online" here is used the way a searcher means it — a web page, no install —
 * and it is accurate. What the tool does NOT do is upload anything, which is
 * what the old name was trying to say and what the copy now says in plain
 * words. See OfflineGuide for the full text and the rule that every claim in it
 * is one the code actually has.
 */
export const metadata: Metadata = pageMetadata({
    /*
     * Leads with the exact entity — "WARC Viewer Online" — rather than a verb
     * phrase. Someone searching types the noun, and Google builds the result
     * title from this and the page's headings, so the first words should be the
     * thing itself.
     */
    title: "WARC Viewer Online – Open WARC, WARC.GZ & WACZ Files",
    /*
     * "No upload" is in the first line because it is the genuine differentiator
     * against the file-converter sites currently ranking for these queries,
     * several of which upload the archive and cap anonymous files at a few
     * megabytes. It is also true, which is the only reason to lead with it.
     */
    description:
        "Open WARC, WARC.GZ and WACZ web archives directly in your browser. No upload, account or installation — files are parsed on your own machine. Browse captured URLs, replay pages and inspect HTTP headers.",
    path: "/warcs/offline",
    keywords: [
        "WARC viewer online",
        "open WARC file",
        "WARC viewer",
        "warc.gz viewer",
        "WACZ viewer",
        "open WARC online",
        "web archive viewer",
    ],
});

export default function OfflineViewerPage() {
    /*
     * Warm the connection to the backend during the server render, so the head of
     * the HTML already carries the hint.
     *
     * This page is the only one that fetches from a second origin at runtime: the
     * parse worker's bundle comes from the Bun backend on :3000, not from Next.
     * Without the hint, the DNS lookup, the TCP handshake and — in production —
     * the TLS handshake all start at the moment the prewarm asks for the bundle,
     * which is the moment it is least welcome.
     *
     * A hint and not a preload, deliberately. `preload` would have the browser
     * download all 190 KB in parallel with the page's own chunks at high priority,
     * which is the competition the prewarm was just moved off the critical path to
     * avoid. This costs no bytes and skips the round trips.
     *
     * React hoists it into <head>; Next needs nothing else.
     */
    // PUBLIC, because a preconnect is an instruction to the reader's browser.
    // Pointing it at the internal address would have every visitor open a
    // connection to a host only this server can reach.
    preconnect(PUBLIC_API_URL);

    return (
        <OfflineContextProvider>
            {/*
              * WebMCP tools for the loaded archive.
              *
              * INSIDE the provider, necessarily — every one of them reads the
              * record index, the view state or the file list, and outside this
              * boundary all three are undefined.
              *
              * Renders nothing, and registers nothing in a browser without
              * WebMCP. The site-wide tools in the root layout cover the online
              * archive; these cover the one in this tab's memory, which the
              * backend has never seen and cannot answer questions about.
              */}
            <OfflineTools />
            {/*
              * Clearing the fixed nav is `padding-top` in page.module.css, the
              * same way app/warcs/view does it. It was `pt-40` plus six literal
              * <br /> tags, which is a layout concern spelled as six empty
              * paragraphs of content.
              *
              * Each section is a Window, like every other page on the site. The
              * offline viewer was the one place that put bare divs straight onto
              * the body gradient.
              */}
            <div className={styles.container}>
                <div className={styles.mainContent}>
                    <script
                        type="application/ld+json"
                        dangerouslySetInnerHTML={{
                            __html: jsonLd(
                                /*
                                 * Through /warcs, which now exists. The middle
                                 * step used to be omitted because the hub was a
                                 * 404 — a breadcrumb whose parent does not
                                 * resolve is worse than a shorter one.
                                 */
                                breadcrumbSchema([
                                    { name: "M4cgyvers Archives", path: "/" },
                                    { name: "Web Archive", path: "/warcs" },
                                    { name: "WARC Viewer", path: "/warcs/offline" },
                                ]),
                                warcViewerSchema(),
                            ),
                        }}
                    />

                    {/*
                      * Two panes, one shown at a time, and no JavaScript in the
                      * switch. #viewer is the tool; #about is the explanation.
                      * The frame's empty state links to #about, the about pane
                      * links back to #viewer, and page.module.css uses :target
                      * to show one and hide the other. A reader who lands on
                      * /warcs/offline#about sees the explanation first; everyone
                      * else sees the viewer at the very top, with nothing above
                      * it — no page header, by request. The <h1> is the frame's
                      * own title (see iframe.tsx).
                      *
                      * The about pane is display:none until targeted, but it is
                      * in the HTML. Search indexes content behind tabs and
                      * toggles as ordinary content; what it will not index is
                      * content that is not there.
                      */}
                    <div id="viewer" className={styles.viewer}>
                        {/*
                          * No Window here: the viewer renders its own, because its
                          * titlebar IS the address bar. A wrapper would put the word
                          * "VIEWER" in a bar directly above a bar reading
                          * "5amgirlfriend.neocities.org/about/ohayo", which is the
                          * same thing said twice and one of them is less useful.
                          */}
                        <WarcOfflineIFrameViewer />

                        {/*
                          * No Window around this one on purpose: it renders null when
                          * nothing is being viewed, and a Window cannot — wrapping it
                          * would leave an empty titlebar sitting there for the whole
                          * time before the reader opens a page. It carries its own
                          * card surface instead.
                          */}
                        <WarcOfflineViewTimeline />

                        {/*
                          * The counts come in as `meta` from two tiny client
                          * components: this page is a server component, and the
                          * numbers live in the store. They belong on the titlebar
                          * because both windows scroll their contents now, and a total
                          * above a scroll pane is the first thing to scroll away.
                          */}
                        <Window title="Load archives" icon="📂" meta={<WarcOfflineFileCount />}>
                            <WarcOfflineFileUploadForm />
                        </Window>

                        <Window title="Records" icon="🗂" meta={<WarcOfflineRecordCount />}>
                            <WarcOfflineRecordListingTree />
                        </Window>
                    </div>

                    <div id="about" className={styles.about}>
                        <OfflineGuide />
                    </div>
                </div>
            </div>
        </OfflineContextProvider>
    );
}
