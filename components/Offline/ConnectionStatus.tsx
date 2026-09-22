"use client"

import { useEffect, useRef, useState } from "react"
import styles from "./ConnectionStatus.module.css"

export default function ConnectionStatus() {
  const [online, setOnline] = useState(true)
  const [justReconnected, setJustReconnected] = useState(false)
  const wasOffline = useRef(false)
  const reconnectTimeout = useRef<number | null>(null)

  useEffect(() => {
    const update = () => {
      const nextOnline = navigator.onLine

      if (!nextOnline) {
        wasOffline.current = true
        setOnline(false)
        setJustReconnected(false)
        if (reconnectTimeout.current !== null) {
          window.clearTimeout(reconnectTimeout.current)
          reconnectTimeout.current = null
        }
        return
      }

      setOnline(true)
      if (wasOffline.current) {
        setJustReconnected(true)
        reconnectTimeout.current = window.setTimeout(() => {
          setJustReconnected(false)
          reconnectTimeout.current = null
        }, 4000)
        wasOffline.current = false
      }
    }

    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)

    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
      if (reconnectTimeout.current !== null) {
        window.clearTimeout(reconnectTimeout.current)
      }
    }
  }, [])

  if (online && !justReconnected) return null

  return (
    <div
      className={`${styles.status} ${online ? styles.online : styles.offline}`}
      role={online ? "status" : "alert"}
      aria-live={online ? "polite" : "assertive"}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span>
        {/*
          * Says what this app can actually do offline, which is not "sync".
          *
          * The previous copy promised "changes will sync when you reconnect".
          * There are no changes: the archive is read-only — no POST, PUT or
          * DELETE anywhere in the frontend, every backend route a GET, and the
          * one server action only calls redirect(). Telling a reader their work
          * is queued when nothing is queued is worse than saying nothing.
          *
          * What IS true offline: pages already visited come from the service
          * worker's cache, and /warcs/offline keeps working entirely, because it
          * parses local files in the browser and never needed the network.
          */}
        {online
          ? "Back online"
          : "Offline — cached pages still work, and the WARC viewer runs without a connection"}
      </span>
    </div>
  )
}
