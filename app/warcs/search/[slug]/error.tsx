"use client"

import Button from "@/components/Button/Button"
import PageHeader from "@/components/PageHeader/PageHeader"

export default function SearchError({ retry }: { retry: () => void }) {
  return (
    <>
      <PageHeader title="Search temporarily unavailable" subtitle="The archive service did not respond." />
      <section aria-live="polite" style={{ display: "grid", gap: "1rem", padding: "1.5rem 0" }}>
        <p>Try again when the database is reachable. Your search can remain open while the service recovers.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <Button onClick={retry}>Retry search</Button>
          <a href="/warcs/search">Start a new search</a>
        </div>
      </section>
    </>
  )
}
