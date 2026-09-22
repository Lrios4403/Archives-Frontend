const CACHE_VERSION = "archives-v3"
const APP_SHELL = ["/", "/warcs/search", "/warcs/offline", "/about", "/guides/how-to-open-warc-file", "/manifest.webmanifest"]
const NAVIGATION_FALLBACK = "/"

/*
 * The archive API is NOT cached, with one deliberate exception.
 *
 * nginx serves `location ^~ /api/warcs/` straight from the Bun backend on this
 * same origin, so every API call is same-origin and a service worker sees all of
 * them regardless of the fact that Next never touches them. Left to the
 * cache-first branch below, that meant:
 *
 *   /api/warcs/search  live Postgres results over 21.3M records, answered from
 *                      cache while the fresh response was written to cache and
 *                      thrown away — every reader one request behind, forever
 *   /api/warcs/info    the same, for capture timelines
 *   /api/warcs/view    archived third-party pages held in the reader's cache
 *
 * None of that is data a cache should be guessing about. It is a live archive;
 * "the answer from last time" is a wrong answer, not a stale one.
 */
const API_PREFIX = "/api/"

/*
 * The exception: the parse worker's bundle.
 *
 * /warcs/offline is the one page here that genuinely works with no network — it
 * parses WARCs locally in a worker pool — and it cannot start a single worker
 * without this script (components/Offline/parserBundle.ts). Skipping all of
 * /api/ would leave the offline viewer unable to work offline, which is a
 * strange thing for a service worker to arrange.
 *
 * NETWORK-FIRST rather than cache-first, and that distinction is the whole
 * safety argument. The bundle is built by the backend and has to match the
 * protocol the backend speaks; a stale copy produces the "worker sent an unknown
 * action" failure parserBundle.ts already carries an error string for. Served
 * network-first, the cached copy is only ever reached when the network is gone —
 * which is exactly the moment a slightly old parser beats no parser at all.
 */
const PARSER_PREFIX = "/api/warcs/parser/"

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

/** Cache a response only if it is one worth keeping. */
const store = (request, response) => {
  if (!response.ok) return
  void caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()))
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // The parser bundle: network-first, cache as a fallback. See PARSER_PREFIX.
  if (url.pathname.startsWith(PARSER_PREFIX)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          store(request, response)
          return response
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error())),
    )
    return
  }

  // Everything else under /api/ goes straight to the network, uncached.
  if (url.pathname.startsWith(API_PREFIX)) return

  if (request.mode === "navigate") {
    /*
     * Network-first, so a cached document is only ever served when the network
     * failed. That matters more than it looks: these pages are prerendered at
     * build time and reference content-hashed chunks under /_next/static/ that
     * change filename on every deploy. Were this cache-first, a returning reader
     * would get yesterday's HTML pointing at chunks that no longer exist, and a
     * redeploy would not fix it.
     */
    event.respondWith(
      fetch(request)
        .then((response) => {
          store(request, response)
          return response
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(NAVIGATION_FALLBACK))),
    )
    return
  }

  /*
   * Everything else — which after the guards above is essentially /_next/static/
   * and public assets — is cache-first, and for those it is correct: the paths
   * are content-hashed and served `immutable, max-age=2592000`, so a hit can
   * never be wrong.
   */
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        store(request, response)
        return response
      })
      return cached || network.catch(() => Response.error())
    }),
  )
})
