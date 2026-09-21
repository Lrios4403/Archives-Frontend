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
        {online ? "Back online — syncing saved changes" : "Offline — changes will sync when you reconnect"}
      </span>
    </div>
  )
}
