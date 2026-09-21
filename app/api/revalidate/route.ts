import { createHash, timingSafeEqual } from "node:crypto"
import { revalidateTag } from "next/cache"

/*
 * The caller the code has been promising itself since the cache tags went in.
 *
 * lib/db.tsx names revalidateTag("archives") in two comments as the precise
 * lever for refreshing the archive's numbers, and until now nothing anywhere
 * called it — `find app -name route.ts` returned nothing at all. So the only
 * thing that has ever flushed a cache entry on this site is a redeploy, which
 * matters twice over: a parse run stayed invisible until a lifetime lapsed, and
 * a cached FAILURE (see DEGRADED_CACHE_LIFE) had no manual clear at all.
 *
 * Two jobs, then. Make a finished parse visible immediately, and be the "the
 * backend is back, please forget what you cached while it was down" button.
 *
 * Called from the parse script on origimagic over the existing WireGuard
 * tunnel, and it must never be able to fail a parse run:
 *
 *   curl -fsS -X POST -H "x-revalidate-secret: $REVALIDATE_SECRET" \
 *     https://archives.m4cgyver.net/api/revalidate || true
 */

/**
 * Both sides hashed before comparison.
 *
 * timingSafeEqual throws on unequal lengths, so comparing the raw strings would
 * need a length check first — and that check is itself a timing oracle for the
 * secret's length. Digests are always 32 bytes, so the comparison is total and
 * constant-time, and the length of the supplied header leaks nothing.
 */
const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest()

/**
 * 404, never 401.
 *
 * A 401 confirms the endpoint exists and is worth grinding at. A 404 is what an
 * unmapped path returns, so an unauthenticated prober cannot tell this route
 * apart from one that was never written. Used for a wrong secret AND for a
 * server with no secret configured, which is the fail-closed default: a missing
 * REVALIDATE_SECRET disables the route rather than opening it.
 */
const notFound = (): Response =>
  new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } })

const authorized = (request: Request): boolean => {
  // NOT NEXT_PUBLIC_ — that prefix would inline the secret into client bundles.
  const expected = process.env.REVALIDATE_SECRET
  if (!expected) return false

  const supplied = request.headers.get("x-revalidate-secret")
  if (!supplied) return false

  return timingSafeEqual(digest(supplied), digest(expected))
}

export function POST(request: Request): Response {
  if (!authorized(request)) return notFound()

  /*
   * "max" is load-bearing, and the wrong second argument here would be worse
   * than not calling this at all.
   *
   * revalidateTag(tag, "max") marks the tag STALE: the cache handler keeps
   * serving the existing entry while a fresh one is fetched. The deprecated
   * one-argument form and { expire: 0 } mark it EXPIRED, which makes the next
   * read a hard miss that blocks on the backend — and this backend is
   * frequently the thing that is down when someone reaches for this button. So
   * the expiring form would convert a routine refresh into a self-inflicted
   * outage.
   *
   * The second argument is also REQUIRED in this version (revalidate.d.ts types
   * it as `profile: string | CacheLifeConfig`, not optional), and both comments
   * in lib/db.tsx showed the old one-argument call — with
   * typescript.ignoreBuildErrors: true, nothing would have caught a copy-paste
   * of them.
   *
   * Honest limit: the default handler checks an entry's age BEFORE its tags, so
   * this only rescues entries still inside their revalidate window. The real
   * beneficiary is the `hours` content-types entry; the `minutes` ones will
   * often have aged out on their own already.
   */
  revalidateTag("archives", "max")

  return Response.json({ revalidated: true, tag: "archives" })
}

/*
 * GET answers 404 as well, so the route is not discoverable by method probing.
 * Without this, Next would answer a GET with 405 Method Not Allowed, which
 * confirms the path exists.
 */
export function GET(): Response {
  return notFound()
}
