import { SITE_NAME, SITE_TAGLINE, SITE_URL, absoluteUrl } from "./site"

/*
 * JSON-LD structured data.
 *
 * The site had none at all — verified against the live pages, 0 `application/
 * ld+json` blocks on every route. Everything else Google's starter guide asks
 * for was already in place (titles, descriptions, canonicals, a sitemap,
 * descriptive URLs, lang), so this is the one whole section that was missing.
 *
 * Deliberately narrow. Only schemas that describe what this site actually IS
 * are here; inventing Ratings or FAQs to farm rich results is the kind of thing
 * that earns a manual action rather than traffic.
 */

/** JSON-LD is embedded as a string; this is the shape every builder returns. */
export type Schema = Record<string, unknown>

/**
 * The site itself, plus how to search it.
 *
 * `potentialAction` is the part that earns something concrete: it tells Google
 * the site has its own search, which is what a sitelinks searchbox is built
 * from. The target has to be a real, working URL template — `/warcs/search?q=`
 * 308-redirects to the canonical `/warcs/search/<slug>` form (verified), so a
 * crawler following it lands on the same page a reader would.
 */
export const websiteSchema = (): Schema => ({
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE_URL}/#website`,
  name: SITE_NAME,
  alternateName: "M4cgyvers WARC Archive",
  description: SITE_TAGLINE,
  url: SITE_URL,
  inLanguage: "en",
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${SITE_URL}/warcs/search?q={search_term_string}`,
    },
    "query-input": "required name=search_term_string",
  },
})

/**
 * Who publishes it.
 *
 * `Organization` rather than `Person`: the site presents itself as an archive,
 * not a personal blog, and the two produce different treatment in Search.
 */
export const organizationSchema = (): Schema => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: SITE_NAME,
  url: SITE_URL,
  description: SITE_TAGLINE,
  logo: {
    "@type": "ImageObject",
    url: absoluteUrl("/opengraph-image"),
    width: 1200,
    height: 630,
  },
})

/**
 * The trail back to the homepage.
 *
 * Google derives breadcrumbs from the URL on its own, but stating them makes
 * the result show "M4cgyvers Archives > Search > myspace.com" rather than a
 * bare URL, and removes the guesswork on slugs that contain dots and encoded
 * characters.
 */
export const breadcrumbSchema = (
  trail: readonly { name: string; path: string }[],
): Schema => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: trail.map((crumb, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: crumb.name,
    item: absoluteUrl(crumb.path),
  })),
})

/**
 * A search-results page, described as the listing it is.
 *
 * `CollectionPage` is honest about what these pages are — a list of captures
 * rather than an article — and `numberOfItems` gives the count without needing
 * a crawler to parse the markup for it.
 */
export const collectionPageSchema = ({
  name,
  description,
  path,
  count,
}: {
  name: string
  description: string
  path: string
  count?: number
}): Schema => ({
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name,
  description,
  url: absoluteUrl(path),
  isPartOf: { "@id": `${SITE_URL}/#website` },
  ...(typeof count === "number" ? { mainEntity: { "@type": "ItemList", numberOfItems: count } } : {}),
})

/**
 * The in-browser WARC viewer, described as the application it is.
 *
 * `WebApplication` — a SoftwareApplication that runs in the browser — rather
 * than one more WebPage: the thing at /warcs/offline is a tool, and Search
 * treats the two differently. `offers` at zero is what Google's
 * SoftwareApplication guidance asks for in place of a rating, and there is no
 * rating to give, so none is invented.
 *
 * `featureList` states ONLY what components/Offline/fileUpload.tsx actually
 * accepts and what the viewer actually does. It is the one machine-readable
 * statement of the supported formats, and a claim here that the picker then
 * rejects is exactly the failure the helpful-content guidance describes.
 */
export const warcViewerSchema = (): Schema => ({
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "@id": `${SITE_URL}/warcs/offline#app`,
  name: "M4cgyvers WARC Viewer",
  alternateName: ["Online WARC viewer", "WACZ viewer", "warc.gz viewer"],
  url: absoluteUrl("/warcs/offline"),
  description:
    "View WARC, WARC.GZ and WACZ web archives in your browser. Files are parsed locally and never uploaded; browse every captured page, its headers and its payload.",
  applicationCategory: "UtilitiesApplication",
  applicationSubCategory: "Web archive viewer",
  /*
   * The platforms, not "Any". `operatingSystem` is one of the properties
   * Google's SoftwareApplication guidance actually names, and "Any" tells a
   * consumer nothing it can match against.
   */
  operatingSystem: "Windows, macOS, Linux",
  browserRequirements: "Requires JavaScript. Built for current desktop Chrome, Edge and Firefox.",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  featureList: [
    "Opens .warc, .warc.gz and .wacz files",
    "Parses locally in the browser; nothing is uploaded",
    "Lists every captured URL, grouped by site",
    "Views pages as originally served, with response headers",
    "Follows redirect chains between captures",
    "Saves an archived page and its assets as a .zip",
    "Parses large plain .warc files across several threads",
  ],
  inLanguage: "en",
  publisher: { "@id": `${SITE_URL}/#organization` },
  isPartOf: { "@id": `${SITE_URL}/#website` },
})

/**
 * A guide article, described as one.
 *
 * `TechArticle` rather than `HowTo`: HowTo is the closer semantic fit for "how
 * to open a WARC file", but Google retired HowTo rich results, so marking it up
 * as one buys nothing and invites the assumption that a rich result is coming.
 * TechArticle is accurate — this is technical documentation — and it is what
 * tells a consumer the page is an article rather than another tool page, which
 * is the distinction that matters when the tool page is one link away.
 *
 * No `aggregateRating` anywhere in this file, deliberately: there are no
 * reviews, and inventing them to chase a rich result is a spam-policy
 * violation rather than a shortcut.
 */
export const techArticleSchema = ({
  headline,
  description,
  path,
  keywords = [],
}: {
  headline: string
  description: string
  path: string
  keywords?: readonly string[]
}): Schema => ({
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "@id": `${absoluteUrl(path)}#article`,
  headline,
  description,
  url: absoluteUrl(path),
  inLanguage: "en",
  ...(keywords.length ? { keywords: keywords.join(", ") } : {}),
  author: { "@id": `${SITE_URL}/#organization` },
  publisher: { "@id": `${SITE_URL}/#organization` },
  isPartOf: { "@id": `${SITE_URL}/#website` },
  /*
   * The article is about the formats and names the viewer; saying so lets a
   * consumer connect this page to the WebApplication node on /warcs/offline
   * rather than treating the two as unrelated documents on one host.
   */
  about: [
    { "@type": "Thing", name: "WARC (Web ARChive) file format" },
    { "@type": "Thing", name: "WACZ (Web Archive Collection Zipped)" },
  ],
  mentions: { "@id": `${SITE_URL}/warcs/offline#app` },
})

/** The "how to open a WARC file" guide. */
export const howToOpenWarcSchema = (): Schema =>
  techArticleSchema({
    headline: "How to Open a WARC File",
    description:
      "Four ways to open a .warc, .warc.gz or .wacz file: in the browser with no install, with ReplayWeb.page, with Python and warcio, or from the command line.",
    path: "/guides/how-to-open-warc-file",
    keywords: [
      "how to open a WARC file",
      "open .warc",
      "WARC file opener",
      "warcio",
      "open warc.gz",
      "WACZ",
    ],
  })

/**
 * Characters that must never appear literally inside a `<script>` body.
 *
 * `<` and `>` are the whole attack: an HTML parser looking at the inside of a
 * `<script>` element does not care that it is JSON, and the first `</script>`
 * it sees ends the element. Everything after that is markup.
 *
 * `&` is escaped too, so the output cannot be reinterpreted as an entity if it
 * is ever moved somewhere HTML-escaped. U+2028 and U+2029 are legal in JSON
 * strings and illegal in JavaScript string literals, which matters the moment
 * anything eval()s or inlines this.
 *
 * All five are written as `\uXXXX`, which is a valid JSON string escape — so
 * `JSON.parse` and every schema.org consumer read back the original character.
 * The escaping is invisible to readers of the data and fatal to the injection.
 */
/*
 * Built with `new RegExp` from a string, NOT written as a regex literal.
 *
 * Turbopack normalises ` ` in source into the actual character, and U+2028
 * IS a JavaScript line terminator — so `/[<>&  ]/g` was emitted as a
 * regex literal split across three lines, and the whole chunk failed to parse
 * with "Invalid regular expression: missing /". Every search page 500'd.
 *
 * The character this file exists to neutralise broke the code neutralising it.
 * In the string form the bundler sees `\\u2028` — an escaped backslash followed
 * by text — and leaves it alone, and RegExp reads the escape itself.
 */
const SCRIPT_UNSAFE = new RegExp("[<>&\\u2028\\u2029]", "g")

/** `<` -> `<`, and so on. A valid JSON escape for any of the five. */
const escapeForScript = (json: string): string =>
  json.replace(SCRIPT_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)

/**
 * Render one or more schemas as a script tag.
 *
 * A single `@graph` rather than several script tags: it is equivalent to
 * consumers, and keeps the `@id` cross-references between WebSite and
 * Organization resolvable within one document.
 *
 * ## Why the escape pass is not optional
 *
 * Every caller feeds this to `dangerouslySetInnerHTML` inside
 * `<script type="application/ld+json">`, and React does NOT escape what goes
 * through that attribute — that is what the word "dangerously" is about. Some
 * of the values are reader-controlled: /warcs/search/[slug] puts the search
 * query into the breadcrumb name and the CollectionPage name and description.
 *
 * So a query of `</script><img src=x onerror=…>` closed the script element and
 * put live markup on the page. Measured against production before this change:
 * requesting /warcs/search/%3C%2Fscript%3EXSSMARKER%3Cb%3E returned a document
 * containing three raw `</script>` sequences inside the ld+json block, with the
 * JSON truncated mid-attribute. It was reachable by link, so it was reachable
 * by anyone who could get a reader to click one.
 *
 * `JSON.stringify` alone does not help: `<` is a perfectly ordinary character
 * in a JSON string and it passes through untouched.
 */
export const jsonLd = (...schemas: Schema[]): string =>
  escapeForScript(
    JSON.stringify(
      schemas.length === 1
        ? schemas[0]
        : { "@context": "https://schema.org", "@graph": schemas.map(({ "@context": _c, ...rest }) => rest) },
    ),
  )
