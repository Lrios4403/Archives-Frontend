/*
 * Canonical identity of the site, in one place.
 *
 * This existed as a bare `const SITE_URL = "https://archives.m4cgyvers.com"` in
 * app/page.tsx — the wrong domain twice over (an extra "s", and .com instead of
 * .net). Nothing caught it because a wrong metadataBase fails silently: pages
 * render, tags are emitted, and every canonical and og:image URL points at a
 * host that does not exist. The only symptom is that link previews are blank and
 * search engines are told the real page lives somewhere else.
 *
 * One constant, imported everywhere, so the next rename is one edit.
 */

/** Production origin. No trailing slash — every consumer appends its own path. */
export const SITE_URL = "https://archives.m4cgyver.net"

export const SITE_NAME = "M4cgyvers Archives"

/** Used as the title suffix and the og:site_name. */
export const SITE_TAGLINE = "Preserving the digital past, one WARC at a time"

export const SITE_LOCALE = "en_US"

export const TWITTER_HANDLE = "@m4cgyvers"

/**
 * Base that Next resolves relative metadata URLs against.
 *
 * Overridable so a preview deployment describes itself rather than claiming to
 * be production, but it defaults to the real origin: getting this wrong locally
 * is harmless, whereas getting it wrong in production is invisible and costly.
 */
export const metadataBase = new URL(process.env.NEXT_PUBLIC_SITE_URL || SITE_URL)

/** Absolute URL for a path, for canonicals and OG. */
export const absoluteUrl = (path = "/"): string =>
  new URL(path, SITE_URL).toString()

/*
 * Keywords every page carries, so the per-page lists only hold what is actually
 * specific to that page.
 */
export const BASE_KEYWORDS = [
  "web archive",
  "WARC",
  "WARC files",
  "digital preservation",
  "internet history",
] as const

/**
 * One shape for every route's metadata.
 *
 * Written because the six routes had drifted into six different shapes: two had
 * no `keywords`, one had no canonical, the homepage repeated `metadataBase` and
 * `robots` that the root layout already provides, and each had invented its own
 * openGraph block. Nothing was broken — it was just impossible to tell whether a
 * missing field was a decision or an oversight.
 *
 * Every field a page can sensibly vary is an argument; everything shared
 * (metadataBase, title template, twitter card, site name, robots default) stays
 * on the root layout and is inherited. A page that needs to deviate passes
 * `robots` explicitly, which makes the deviation visible at the call site
 * instead of being an absence.
 */
export const pageMetadata = ({
  title,
  description,
  path,
  keywords = [],
  robots,
  absoluteTitle = false,
}: {
  title: string
  description: string
  /** Site-relative, e.g. "/warcs/offline". Used for canonical and og:url. */
  path: string
  keywords?: readonly string[]
  /** Only when it differs from the root layout's index/follow. */
  robots?: { index: boolean; follow: boolean }
  /** Skip the "| M4cgyvers Archives" suffix — for the homepage, which is it. */
  absoluteTitle?: boolean
}) => ({
  title: absoluteTitle ? { absolute: title } : title,
  description,
  keywords: [...BASE_KEYWORDS, ...keywords],
  alternates: { canonical: path },
  /*
   * The image is listed EXPLICITLY, and it has to be.
   *
   * app/opengraph-image.tsx is injected by Next into the openGraph object it
   * builds — but a page that declares `openGraph` REPLACES the inherited one
   * wholesale rather than merging into it. So every route that set its own
   * og:title silently dropped og:image, and only the homepage (which inherits)
   * had one. Measured: og:image present on "/", missing on the other four.
   *
   * "/opengraph-image" is the file convention's own route; metadataBase turns it
   * absolute. Same reasoning for `twitter` below — declaring it anywhere would
   * otherwise discard the card type and handle set on the root layout.
   */
  openGraph: {
    url: absoluteUrl(path),
    title,
    description,
    siteName: SITE_NAME,
    locale: SITE_LOCALE,
    type: "website" as const,
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: `${SITE_NAME} — ${SITE_TAGLINE}` }],
  },
  twitter: {
    card: "summary_large_image" as const,
    creator: TWITTER_HANDLE,
    title,
    description,
    images: ["/opengraph-image"],
  },
  ...(robots ? { robots } : {}),
})
