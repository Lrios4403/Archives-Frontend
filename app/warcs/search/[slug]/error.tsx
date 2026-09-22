"use client"

import { useEffect, useState } from "react"
import Button from "@/components/Button/Button"
import PageHeader from "@/components/PageHeader/PageHeader"

export default function SearchError({ retry }: { retry: () => void }) {
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])

  return (
    <>
      <PageHeader title="Search temporarily unavailable" subtitle={online ? "The archive service did not respond." : "You are offline. Reconnect before retrying."} />
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
