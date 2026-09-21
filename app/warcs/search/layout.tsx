import type React from "react"
import type { Metadata } from "next"
import { pageMetadata } from "@/lib/site"
import styles from "./page.module.css"

export const metadata: Metadata = pageMetadata({
  title: "Search the Archive",
  description:
    "Search archived web pages by URL or keyword. Filter by content type across every WARC file in the collection and open any capture as it was originally served.",
  path: "/warcs/search",
  keywords: ["WARC search", "search archived websites", "find old web pages"],
})

export default function WarcSearchLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className={styles.container}>
      <div className={styles.mainContent}>
        {children}
      </div>
    </div>
  )
}
