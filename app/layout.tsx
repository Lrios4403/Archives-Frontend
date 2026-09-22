import type React from "react"
import type { Metadata, Viewport } from "next"
import { JetBrains_Mono, Fira_Code } from "next/font/google"
import "./globals.css"
import Navigation from "@/components/Navigation/Navigation"
import { jsonLd, organizationSchema, websiteSchema } from "@/lib/schema"
import ArchiveTools from "@/components/WebMCP/ArchiveTools"
import ConnectionStatus from "@/components/Offline/ConnectionStatus"
import ServiceWorkerRegistration from "@/components/Offline/ServiceWorkerRegistration"
import PerformanceMonitor from "@/components/Performance/PerformanceMonitor"
import {
  SITE_LOCALE,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
  TWITTER_HANDLE,
  metadataBase,
} from "@/lib/site"

// Optimized Google Fonts
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jetbrains-mono",
  display: "swap",
})

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-fira-code",
  display: "swap",
})

/*
 * Everything shared lives HERE, not on each page.
 *
 * metadataBase in particular was set only on the homepage, so every other route
 * resolved og:image and canonical URLs against the dev server's own origin —
 * shipping http://localhost:3001/... to crawlers and link unfurlers. Defined on
 * the root layout it is inherited by every route, and a page can only add to it.
 *
 * `title.template` gives each page a suffix without repeating the site name in
 * eight files; a page sets `title: "WARC Search"` and gets
 * "WARC Search | M4cgyvers Archives". `title.default` covers routes that set no
 * title at all.
 */
export const metadata: Metadata = {
  metadataBase,
  title: {
    default: `${SITE_NAME} — ${SITE_TAGLINE}`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_TAGLINE,
  applicationName: SITE_NAME,
  keywords: ["web archive", "WARC", "digital preservation", "internet history"],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: "technology",
  // Default posture; routes that serve third-party content override it.
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: SITE_LOCALE,
    url: SITE_URL,
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_TAGLINE,
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: SITE_NAME, statusBarStyle: "default" },
  twitter: {
    card: "summary_large_image",
    creator: TWITTER_HANDLE,
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_TAGLINE,
  },
}

/*
 * viewport and themeColor belong in their own export.
 *
 * Next 16 ignores them inside `metadata` and warns on every render:
 * "Unsupported metadata viewport is configured in metadata export". They were in
 * BOTH places on the homepage, so the theme colour was being emitted from the
 * viewport export and simultaneously warned about from the metadata one.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#c0c0c0" },
    { media: "(prefers-color-scheme: dark)", color: "#008080" },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${jetbrainsMono.variable} ${firaCode.variable}`}>
      <body className={jetbrainsMono.className}>
        {/*
          * Site-wide structured data, on the root layout so every route carries
          * it. WebSite declares the search endpoint (the basis of a sitelinks
          * searchbox) and Organization says who publishes this; both are
          * referenced by @id from the per-page schemas.
          */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLd(websiteSchema(), organizationSchema()) }}
        />
        {/*
          * WebMCP tools, declared once for the whole site.
          *
          * Here rather than per-route so an agent that lands anywhere has the
          * full toolset — the lookups are read-only and page-independent, and
          * the two navigation tools work from any page.
          *
          * Renders nothing, and does nothing at all in a browser without
          * WebMCP, which today is nearly all of them.
          *
          * One constraint worth knowing before moving this: it has to HYDRATE
          * to register anything. On Next 16.3.2 postponed content never
          * hydrates, which is why /warcs/search/[slug] sets `instant = false`
          * and carries no <Suspense>. Put a Suspense boundary above this and
          * the tools silently stop existing, with nothing in the console.
          */}
        <ArchiveTools />
        <ServiceWorkerRegistration />
        <PerformanceMonitor />
        <ConnectionStatus />
        <Navigation />
        {children}
      </body>
    </html>
  )
}
