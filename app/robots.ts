import type { MetadataRoute } from "next"
import { SITE_URL, absoluteUrl } from "@/lib/site"

/*
 * Generated rather than a static file, so the sitemap URL and the disallow list
 * cannot drift from lib/site.ts and the route tree.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          /*
           * The viewer renders captured third-party pages. Excluded here as well
           * as via the route's own noindex, because the two do different jobs: a
           * meta tag is only seen AFTER a crawler fetches the page, and every
           * capture is a distinct URL. Left to robots alone this is an unbounded
           * crawl space over content we did not write; left to noindex alone it
           * gets crawled in full before being discarded.
           */
          "/warcs/view",
          // Proxied backend routes - zips, the parser bundle, JSON. Nothing here
          // is a page, and /api/warcs/download would have a crawler pulling
          // multi-gigabyte archives.
          "/api/",
        ],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: SITE_URL,
  }
}
