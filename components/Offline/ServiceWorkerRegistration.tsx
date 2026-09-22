"use client"

import { useEffect } from "react"

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      /*
       * Nothing to reload for if there was no controller to begin with.
       *
       * `clients.claim()` in the worker's activate fires `controllerchange` on
       * every client whose controller changed — and null -> worker counts. Since
       * this is the first service worker this origin has ever had, EVERY visitor
       * hits that transition on their first page, so without this guard every
       * one of them gets the page reloaded underneath them seconds after it
       * loads. Unsubmitted text in the search box is state, not URL, so it is
       * gone; and on /warcs/view the reload re-runs a live backend query.
       *
       * Captured before register() so it reflects the state on arrival: after an
       * UPDATE there is a controller, and reloading to pick up new assets is the
       * point. It is only the first-ever install that must be silent.
       */
      const hadController = Boolean(navigator.serviceWorker.controller)

      let refreshing = false
      const onControllerChange = () => {
        if (!hadController) return
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
