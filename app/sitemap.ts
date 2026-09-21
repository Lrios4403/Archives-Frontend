import type { MetadataRoute } from "next"
import { INTERNAL_API_URL } from "@/lib/api"
import { slugForQuery } from "@/components/WarcSearch/actions"
import { absoluteUrl } from "@/lib/site"
import { readSnapshot, writeSnapshot } from "@/lib/snapshot"

/*
 * No `priority`, and no `changeFrequency`.
 *
 * Google ignores both — it says so outright — and every entry here used to
 * carry them anyway, including a comment conceding the point. They are not
 * harmless filler: a file full of fields the consumer discards reads as though
 * it were tuning something, and invites the next person to tune it harder.
 *
 * `lastmod` is the field Google actually uses, and it was the one field missing.
 * It is supplied here ONLY where a real date exists — see below.
 */

/** One archived site, and when it was last captured. */
interface HostEntry {
  host: string
  /** ISO 8601, or null when no capture under this host carried a usable date. */
  lastModified: string | null
}

/**
 * How many archived sites to list.
 *
 * The corpus holds ~10,800 distinct URIs. Listing all of them would be a
 * sitemap of mostly near-identical thin pages competing with each other, which
 * is the opposite of useful — and Google treats a sitemap as a claim that these
 * URLs are worth indexing. 500 of the most-captured sites is a real discovery
 * surface without that.
 */
const MAX_SITES = 500

/**
 * The hand-written pages.
 *
 * Deliberately NO `lastModified` on most of them. Google discounts the field
 * when it does not track real change, so inventing a date for a page whose text
 * only changes when someone edits it is worse than omitting it: it spends the
 * credibility of every honest date in the file. The two exceptions below are
 * the pages whose content genuinely is the corpus.
 */
const staticRoutes = (corpusLastModified: string | null): MetadataRoute.Sitemap => [
  // The homepage lists the most recent captures, so it moves when they do.
  { url: absoluteUrl("/"), ...(corpusLastModified ? { lastModified: corpusLastModified } : {}) },
  { url: absoluteUrl("/warcs/offline") },
  { url: absoluteUrl("/warcs") },
  { url: absoluteUrl("/warcs/search") },
  // "Browse every archived URL" — literally a view of the whole corpus.
  {
    url: absoluteUrl("/warcs/search/all"),
    ...(corpusLastModified ? { lastModified: corpusLastModified } : {}),
  },
  { url: absoluteUrl("/guides/how-to-open-warc-file") },
  { url: absoluteUrl("/about") },
]

/**
 * Hostnames and capture dates, from the backend.
 *
 * Keyed on HOSTNAME, not the full URI, and this is the whole point.
 * slugForQuery double-encodes (see its own note), so a full URI becomes
 *   /warcs/search/http%253A%252F%252F101.ru%253Fan%253Dport_channel_mp3...
 * which is exactly the "URL that only contains random identifiers" Google's
 * guide warns against — unreadable in a result, useless as a breadcrumb. A
 * hostname stays legible: /warcs/search/101.ru
 *
 * It is also the better page. A host is what someone actually searches for, and
 * the results list every capture of that site rather than one URL — so these are
 * real collection pages instead of 500 near-duplicate singletons.
 */
const fetchHosts = (): Promise<HostEntry[]> =>
  fetch(`${INTERNAL_API_URL}/api/warcs/search?q=&offset=0&limit=${MAX_SITES}`, {
    // A day: the corpus changes when a parse run finishes, not per request, and
    // this runs at build time where a slow call delays the whole build.
    next: { revalidate: 86_400 },
    signal: AbortSignal.timeout(20_000),
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

    return response.json().then((data: { groups?: { uri?: string; responses?: { archived_date?: string }[] }[] }) => {
      /*
       * Newest capture per host, which is a real lastmod rather than a proxy
       * for one. Note what is NOT used: the backend's status `date`, which is
       * the time of the READING — using it would stamp every page "modified
       * just now" on every crawl, the precise dishonest-freshness signal
       * Google's guidance singles out.
       *
       * Many URIs share a host, so this also does the deduping: one entry per
       * host, holding the latest date seen under it.
       */
      const newest = new Map<string, number>()

      for (const group of data.groups ?? []) {
        if (typeof group.uri !== "string" || !group.uri) continue

        let host: string
        try {
          host = new URL(group.uri).hostname
        } catch {
          continue
        }
        if (!host) continue

        if (!newest.has(host)) newest.set(host, 0)
        for (const response of group.responses ?? []) {
          const at = Date.parse(response?.archived_date ?? "")
          if (Number.isFinite(at) && at > newest.get(host)!) newest.set(host, at)
        }
      }

      return [...newest.entries()].map(([host, at]) => ({
        host,
        lastModified: at ? new Date(at).toISOString() : null,
      }))
    })
  })

/**
 * The sitemap.
 *
 * NEVER throws. `next build` runs this, and the last time a build reached for
 * the backend and it was not there, the whole build failed.
 *
 * The failure path is now a snapshot rather than a stub. Previously an outage
 * reduced this to the hand-written routes alone — and because it runs at build
 * time, a deploy during an outage shipped that seven-URL sitemap and served it
 * until the next one. The archive's own discovery surface would have quietly
 * vanished for however long that was.
 *
 * /warcs/view stays out of it: it serves captured third-party pages and is
 * noindex, and a sitemap advertising URLs the robots tag then refuses would be
 * contradicting itself.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const hosts = await fetchHosts()
    .then((fresh) => {
      if (fresh.length > 0) writeSnapshot("sitemap-hosts", fresh, new Date().toISOString())
      return fresh
    })
    .catch((error) => {
      console.error("sitemap: falling back to the last known host list:", error)
      return readSnapshot<HostEntry[]>("sitemap-hosts")?.value ?? []
    })

  /*
   * The whole corpus's newest capture, for the two pages that are views of it.
   * Taken from the same list, so it cannot disagree with the per-host dates.
   */
  const corpusLastModified =
    hosts
      .map((entry) => entry.lastModified)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null

  return [
    ...staticRoutes(corpusLastModified),
    ...hosts.map((entry) => ({
      url: absoluteUrl(`/warcs/search/${slugForQuery(entry.host)}`),
      ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
    })),
  ]
}
