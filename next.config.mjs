/** @type {import('next').NextConfig} */
const nextConfig = {
  // Partial Prerendering. Next 16 replaced the old experimental.ppr flag with
  // this. Each route is prerendered down to the first thing that needs
  // request-time data; that shell is served instantly from the build output and
  // every Suspense hole inside it streams in afterwards. Requires that anything
  // reading uncached data sits inside a <Suspense>, or is marked "use cache".
  cacheComponents: true,

  /**
   * The parse worker's bundle, proxied so the browser sees ONE origin.
   *
   * `new Worker(url)` refuses a cross-origin script outright. That is why the
   * frontend used to fetch the bundle, wrap it in a Blob and hand out an object
   * URL — which works, and costs a fresh 190 KB compile per worker, because a
   * blob URL gets neither the HTTP cache nor V8's code cache. Spawning one worker
   * per hardware thread made that a visible stutter.
   *
   * Rewriting the path makes it same-origin, so the workers take a plain string
   * synchronously and the browser caches both the bytes and the compiled form.
   * The bundle is still built in exactly one place: the Bun backend.
   *
   * Returned as an array, which Next treats as `afterFiles` — real routes win
   * first, so this cannot shadow anything under app/.
   */
  /**
   * Old `?q=` search links, moved into the path.
   *
   * Done HERE rather than in the page, and that is the whole point: a page that
   * reads `searchParams` in order to redirect is a page that reads searchParams,
   * which cannot be prerendered. Answering it at the config level keeps
   * /warcs/search a fully static route while old links, bookmarks and anything
   * already indexed keep working.
   *
   * It also catches the no-JS path for free: the search form still posts a plain
   * GET with `?q=`, so a reader without JavaScript lands here and is forwarded.
   *
   * Two rules, because an empty query is a real search in this app (it matches
   * every URI) and needs the browse-all slug rather than an empty segment. The
   * empty rule is FIRST — `.+` would not match it, but ordering makes the intent
   * legible rather than depending on that.
   */
  async rewrites() {
    /*
     * The INTERNAL url, matching lib/api.ts.
     *
     * A rewrite destination is dialled by the Next server, not the browser —
     * the browser only ever sees the same-origin `source` path. So this is the
     * server's view of the backend, and under a tunnel it can be an address no
     * client could resolve.
     *
     * Duplicated from lib/api.ts rather than imported: this file is loaded by
     * the Next config loader before the TS path aliases exist, so importing
     * from `@/lib/api` here fails at startup. The fallback chain is kept
     * identical on purpose.
     */
    const backend =
      process.env.API_INTERNAL_URL
      ?? process.env.NEXT_PUBLIC_API_URL
      ?? 'http://localhost:3000'

    return [
      {
        source: '/api/warcs/parser/:path*',
        destination: `${backend}/api/warcs/parser/:path*`,
      },
      /*
       * Downloads, proxied for a different reason than the parser bundle.
       *
       * Nothing here needs same-origin to FUNCTION — a cross-origin link with
       * `Content-Disposition: attachment` downloads perfectly well. What it needs
       * it for is the `download` attribute, which browsers ignore cross-origin,
       * and for the backend's address to live in one place instead of being
       * inlined into every component that links to a zip.
       */
      {
        source: '/api/warcs/download',
        destination: `${backend}/api/warcs/download`,
      },
      /*
       * The nearest-capture lookup, proxied because the VIEWER calls it from the
       * browser.
       *
       * Everything else in lib/db.tsx runs on the server, where cross-origin does
       * not apply. This one does not: when a link inside an archived page posts
       * `warc-navigate`, the page around the frame has to turn that url into a
       * warc_custom_id before it can route, and it is a client component doing
       * it. The Bun backend sends no Access-Control-Allow-Origin, so a direct
       * fetch to :3000 is blocked by the browser — verified, not assumed.
       *
       * Proxying rather than adding CORS to the backend keeps the allowed-origin
       * question from existing at all, and matches how the parser bundle and the
       * download endpoint are already reached.
       */
      {
        source: '/api/warcs/near',
        destination: `${backend}/api/warcs/near`,
      },
    ]
  },

  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
