import { NextResponse, type NextRequest } from "next/server"
import { slugForQuery } from "@/components/WarcSearch/actions"

/**
 * Old `/warcs/search?q=…` links, forwarded into the path form.
 *
 * ## Why this is not `redirects()` in next.config
 *
 * It was, first, and config redirects get all three of these wrong:
 *
 *   1. They append the source's query string to the destination whether or not
 *      the destination already used it, so `?q=geocities.com` arrived as
 *      `/warcs/search/geocities.com?q=geocities.com` — the old parameter
 *      surviving the redirect that exists to retire it.
 *   2. `has: [{ type: 'query', key: 'q', value: '' }]` does not mean "matches
 *      the empty value", it matches anything, so as the first rule it sent every
 *      search to browse-all. Presence-only (`{ key: 'q' }`) then failed to match
 *      `?q=` at all, so the empty search never redirected.
 *   3. A capture is substituted into the path already decoded, so `?q=a%2Fb`
 *      became `/warcs/search/a/b` — two segments, which the single `[slug]`
 *      route does not match.
 *
 * All three are cases where the rewrite needs to make a decision about a VALUE,
 * which is what this file can do and a declarative rule cannot.
 *
 * ## Why the redirect exists at all
 *
 * So that `/warcs/search` can stay a static page. A route that reads
 * `searchParams` — even only to redirect — cannot be prerendered, and under
 * Cache Components anything it defers behind `<Suspense>` is postponed and never
 * hydrates. Answering here keeps the landing page static and keeps every
 * existing bookmark and indexed link working.
 *
 * It also covers the no-JS path: the search form still posts a plain GET with
 * `?q=`, because a GET form cannot build a path segment out of an input value.
 */
export function proxy(request: NextRequest) {
    const query = request.nextUrl.searchParams.get("q")

    // Not an old-style search link. `null` and not `""` — an empty `?q=` is a
    // real search here and does need forwarding.
    if (query === null) return NextResponse.next()

    const url = request.nextUrl.clone()

    /*
     * The SAME slug builder the links use, so a redirected url and a clicked one
     * are byte-identical. Assigning the raw query here instead — which is what
     * this did first — sent "a/b" to `/warcs/search/a/b`, two segments that the
     * single `[slug]` route does not match, and "100%" to a 500.
     */
    url.pathname = `/warcs/search/${slugForQuery(query)}`
    url.searchParams.delete("q")

    // 308 rather than 302: the query genuinely lives at the new address now, and
    // the method must be preserved for the form's GET.
    return NextResponse.redirect(url, 308)
}

// Only the old search route. Everything else — including the static landing page
// and the prerendered homepage — is never touched.
export const config = { matcher: "/warcs/search" }
