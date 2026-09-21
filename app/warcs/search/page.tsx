import WarcSearchInterface from "@/components/WarcSearch/WarcSearchInterface"
import ErrorBoundary from "@/components/ErrorBoundary/ErrorBoundary"
import { getContentTypesReal } from "@/lib/db"
import styles from "./page.module.css"
import PageHeader from "@/components/PageHeader/PageHeader"
import { breadcrumbSchema, jsonLd } from "@/lib/schema"

/*
 * The search LANDING page, and nothing else.
 *
 * It reads no searchParams and no params, so it prerenders to a fully static
 * page with zero postponed boundaries — which is the only shape whose
 * JavaScript actually runs under Cache Components on Next 16.3.2. Before the
 * split this route read `searchParams` to decide between the prompt and the
 * results, which forced both behind <Suspense>, and everything behind a
 * Suspense boundary is postponed and never hydrates. The search box on the
 * search page did not work.
 *
 * Results moved to ./[slug], which is blocking. Old `?q=` links are redirected
 * there by next.config.mjs, so nothing reaching this file carries a query.
 *
 * The content-type list is cached (see getContentTypesReal), so awaiting it here
 * completes during prerendering and ships in the shell rather than holding the
 * page back.
 */
export default async function SearchLandingPage() {
  const contentTypes = await getContentTypesReal()

  return (
    <>
      {/* The h1 this page never had: it imported PageHeader and never rendered it. */}
      <PageHeader title="Search the Archive" subtitle="Find archived pages across every WARC in the collection" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([
          { name: "M4cgyvers Archives", path: "/" },
          { name: "Search", path: "/warcs/search" },
        ])) }}
      />
      <ErrorBoundary>
        <WarcSearchInterface contentTypes={contentTypes} searched={false} />
      </ErrorBoundary>

      <div className={styles.emptyState}>
        <div className={styles.emptyStateIcon}>🔍</div>
        <h3 className={styles.emptyStateTitle}>Ready to Search</h3>
        <p className={styles.emptyStateMessage}>
          Enter a search term above to find archived web content. Try searching for popular sites like "myspace.com"
          or "geocities.com" — or search with an empty box to browse everything.
        </p>
      </div>
    </>
  )
}
