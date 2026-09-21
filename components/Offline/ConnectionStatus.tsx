"use client"

import { useEffect, useState } from "react"
import styles from "./ConnectionStatus.module.css"

export default function ConnectionStatus() {
  const [online, setOnline] = useState(true)
  const [reconnecting, setReconnecting] = useState(false)
  const [justReconnected, setJustReconnected] = useState(false)

  useEffect(() => {
    const update = () => {
      const nextOnline = navigator.onLine
      setOnline(nextOnline)
      setReconnecting(!nextOnline)
      if (nextOnline) {
        setJustReconnected(true)
        const timeout = window.setTimeout(() => setJustReconnected(false), 4000)
        return () => window.clearTimeout(timeout)
      }
    }
    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])

  if (online && !justReconnected) return null

  return (
    <div className={`${styles.status} ${online ? styles.online : styles.offline}`} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <span>{reconnecting ? "Offline — changes will sync when you reconnect" : "Back online — syncing saved changes"}</span>
    </div>
  )
}
