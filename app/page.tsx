import Navigation from "@/components/Navigation/Navigation"
import SearchBar from "@/components/SearchBar/SearchBar"
import RecentArchives from "@/components/RecentArchives/RecentArchives"
import DesktopIcons from "@/components/DesktopIcons/DesktopIcons"
import ErrorBoundary from "@/components/ErrorBoundary/ErrorBoundary"
import PageHeader from "@/components/PageHeader/PageHeader"
import styles from "./page.module.css"
import type { Metadata } from "next"
import { pageMetadata } from "@/lib/site"
import { ArchivesFooter } from "@/components/archivesFooter"

/*
 * Only what is specific to this page. metadataBase, the title template,
 * robots, og:site_name, twitter:card and themeColor are all on the root layout
 * now — repeating them here is how the wrong domain survived in one file while
 * the rest of the site was fine.
 */
export const metadata: Metadata = pageMetadata({
  // absoluteTitle: this route IS the site, so the "| M4cgyvers Archives" suffix
  // would read "M4cgyvers Archives ... | M4cgyvers Archives".
  absoluteTitle: true,
  title: "M4cgyvers Archives — Search Archived Websites & WARC Files",
  description:
    "Search and browse archived websites preserved as WARC files. Explore captures of forums, personal sites and early-web pages, or open a WARC directly in your browser.",
  path: "/",
  keywords: ["WARC viewer", "archived websites", "wayback"],
})

export default function HomePage() {
  return (
    <>
      <div className={styles.container}>
        <div className={styles.mainContent}>
          <PageHeader title="M4cgyvers Archives" subtitle="Preserving the digital past, one WARC at a time" />

          <ErrorBoundary>
            <SearchBar />
          </ErrorBoundary>

          <RecentArchives />

          {/* Desktop icons shown in content on mobile only */}
          <div className={styles.desktopIconsContainer}>
            <DesktopIcons />
          </div>

          <ArchivesFooter />
        </div>
      </div>
    </>
  )
}
