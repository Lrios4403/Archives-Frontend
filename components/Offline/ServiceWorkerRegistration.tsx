"use client"

import { useEffect } from "react"

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      let refreshing = false
      const onControllerChange = () => {
        if (refreshing) return
        refreshing = true
        window.location.reload()
      }

      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
        registration.update().catch(() => undefined)
        if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" })
      }).catch(() => undefined)

      return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
    }
  }, [])
  return null
}
