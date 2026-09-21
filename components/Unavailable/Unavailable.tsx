import Link from "next/link"
import Window from "@/components/Window/Window"
import type { Unavailable as UnavailableInfo, UnavailableKind } from "@/lib/db"
import styles from "./Unavailable.module.css"

/*
 * One panel for "we could not ask the archive", used by the search results and
 * the homepage.
 *
 * Shared rather than copied because the wording is the whole point of it. Two
 * hand-written versions drift, and the one nobody looked at recently is the one
 * that still says "no results found" when it means "no answer received".
 */

/*
 * Per-kind icon, headline, and the one clause that says what became of the
 * request. The `reason` sentence still comes from lib/db's classifier.
 *
 * WHY `outcome` IS PER-KIND AND NOT ONE SHARED SENTENCE
 * ---------------------------------------------------------------------------
 * This paragraph used to read, for every kind alike, "<attempted> was not run,
 * so this is not a result". That is a claim about what the BACKEND did, and
 * nothing on this side of the fetch can see it. It is true for a backend that
 * is not listening. It was false the day a search for "kiwifarms.net" ran at
 * the archive for nineteen seconds while lib/db's AbortSignal.timeout gave up on
 * it at ten (BACKEND_TIMEOUT_MS) - the query ran, the row count had already come
 * back in ~60ms, and the panel told the reader the search had never happened.
 *
 * What this component CAN see is `info.kind`, which is exactly the set of
 * outcomes describeFailure is able to tell apart, so each kind states its own
 * and none of them states more than the classifier established:
 *
 *   - a refusal (401/403/429/other 4xx, or a 404 route) is a real "not run":
 *     something declined the request instead of executing it.
 *   - a timeout is the case the old copy got wrong. We stopped waiting; whether
 *     the archive was idle, mid-query, or finished a second later is not
 *     observable from here, and the copy no longer pretends otherwise.
 *   - an error or an unreadable body means the request got somewhere and came
 *     back wrong, which is neither "not run" nor a result.
 *
 * The shared tail after the em-dash is the part that was always true and is
 * still the point of the whole panel: whatever happened, this is not an answer
 * about what the archive holds.
 */
const PRESENTATION: Record<
  UnavailableKind,
  { icon: string; title: string; retry: boolean; outcome: string; retryHint?: string }
> = {
  offline: {
    icon: "🔌",
    title: "Can't reach the archive right now",
    retry: true,
    outcome: "got no response from the archive at all",
  },
  timeout: {
    icon: "⏳",
    title: "The archive is taking too long",
    retry: true,
    outcome: "was still unanswered when this page gave up waiting, and may have been running at the archive the whole time",
    /*
     * Not "this is usually brief", which is the generic line below and which was
     * wrong in the incident this copy was rewritten for. A search whose term
     * matches millions of URIs is slow structurally, not momentarily: the sort
     * key means every page of it re-walks the same long prefix of non-matching
     * index entries, so the identical query costs the same seconds on the next
     * attempt. Narrowing it is the thing that actually helps.
     */
    retryHint: "Try again, or use a more specific term - a query matching a large slice of the archive is slow every time, not just this time",
  },
  server: {
    icon: "💢",
    title: "The archive backend errored",
    retry: true,
    outcome: "reached the archive, which errored instead of answering",
  },
  // Retrying a 404 is pointless: the route is not there to be found. Saying
  // "try again in a moment" would send a reader round a loop that cannot end.
  notFound: {
    icon: "🧩",
    title: "This site expects a newer backend",
    retry: false,
    outcome: "was sent to an archive endpoint that does not exist, so nothing ran it",
  },
  denied: {
    icon: "🔒",
    title: "The archive refused the request",
    retry: false,
    outcome: "was refused rather than run",
  },
  throttled: {
    icon: "🚦",
    title: "Too many requests",
    retry: true,
    outcome: "was turned away by rate limiting rather than run",
  },
  rejected: {
    icon: "❓",
    title: "The archive couldn't answer that",
    retry: false,
    outcome: "was rejected rather than run",
  },
  malformed: {
    icon: "📛",
    title: "The archive sent something unreadable",
    retry: true,
    outcome: "came back as something this site could not read, so what the archive made of it is not visible from here",
  },
}

export default function Unavailable({
  info,
  title,
  /** What was being attempted, e.g. `your search for "5am"`. Optional. */
  attempted,
  children,
}: {
  info: UnavailableInfo
  title?: string
  attempted?: string
  children?: React.ReactNode
}) {
  const { icon, title: headline, retry, outcome, retryHint } =
    PRESENTATION[info.kind] ?? PRESENTATION.offline

  return (
    <div className={styles.container}>
      <Window title={title ?? "Unavailable"} icon={icon}>
        <div className={styles.body}>
          <div className={styles.icon}>{icon}</div>
          <h3 className={styles.title}>{headline}</h3>

          <p className={styles.message}>
            {info.reason}
            {attempted ? (
              <>
                {" "}
                {/*
                  * Said explicitly, because the empty page behind this notice is
                  * indistinguishable from a genuine "nothing matched". A reader
                  * who is not told will reasonably conclude the archive has
                  * nothing - the one thing we do NOT know.
                  *
                  * `outcome` carries whatever the classifier actually
                  * established; the clause after it is the part that holds for
                  * every kind. See the note on PRESENTATION for what the old
                  * wording claimed and why it could not.
                  */}
                <strong>{attempted}</strong> {outcome} - what you are looking at is
                not a result, and the archive may well hold matches.
              </>
            ) : null}
          </p>

          <div className={styles.suggestions}>
            <p className={styles.suggestionsTitle}>What to try:</p>
            <ul className={styles.suggestionsList}>
              {retry ? (
                // The generic line assumes a blip. Kinds that know better say so
                // themselves - see `retryHint` on the timeout entry.
                <li>{retryHint ?? "Try again shortly - this is usually brief"}</li>
              ) : (
                <li>Retrying will not help with this one</li>
              )}
              {/*
                * Honest about the dependency. This said "still works", and it
                * was wrong precisely when it was shown: the viewer fetches its
                * parser bundle through the same backend route this panel is
                * reporting as unreachable (see Offline/parserBundle.ts). The
                * link stays - it is the right place to send someone with a
                * file of their own - but it no longer promises an outcome.
                */}
              <li>
                The <Link href="/warcs/offline">WARC viewer</Link> can open a .warc, .warc.gz or .wacz you already
                have; it fetches its parser from the same backend, so it may be affected too
              </li>
              {info.status ? (
                <li>
                  Reported status: HTTP <code>{info.status}</code>
                </li>
              ) : (
                <li>No response was received at all</li>
              )}
            </ul>
            {children}
          </div>
        </div>
      </Window>
    </div>
  )
}
