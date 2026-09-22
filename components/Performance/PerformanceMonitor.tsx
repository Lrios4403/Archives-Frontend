"use client"

import { useEffect } from "react"

/** Lightweight production-safe telemetry for frontend responsiveness. */
export default function PerformanceMonitor() {
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return

    const observers: PerformanceObserver[] = []
    const observe = (type: string, callback: PerformanceObserverCallback) => {
      try {
        const observer = new PerformanceObserver(callback)
        observer.observe({ type, buffered: true })
        observers.push(observer)
      } catch {
        // Browsers can omit optional entry types; instrumentation must never
        // affect the archive UI.
      }
    }

    observe("longtask", (list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 200) {
          document.dispatchEvent(new CustomEvent("archive:longtask", { detail: { duration: entry.duration } }))
        }
      }
    })

    observe("largest-contentful-paint", () => undefined)

    return () => observers.forEach((observer) => observer.disconnect())
  }, [])

  return null
}
