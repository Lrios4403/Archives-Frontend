const CACHE_VERSION = "archives-v3"
const APP_SHELL = ["/", "/warcs/search", "/warcs/offline", "/about", "/guides/how-to-open-warc-file", "/manifest.webmanifest"]
const NAVIGATION_FALLBACK = "/"

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting()
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) void caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()))
          return response
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(NAVIGATION_FALLBACK))),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) void caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()))
        return response
      })
      return cached || network.catch(() => Response.error())
    }),
  )
})
