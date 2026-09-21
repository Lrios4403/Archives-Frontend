import { mkdirSync, readFileSync, renameSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import seedContentTypes from "./snapshots/content-types.json"
import seedLatest from "./snapshots/latest.json"
import seedSitemapHosts from "./snapshots/sitemap-hosts.json"
import seedStatus from "./snapshots/status.json"

/*
 * Last-known-good readings, kept BELOW the cache.
 *
 * The cache cannot provide durability and it is worth being precise about why.
 * In production the default cache handler's retention is `entry.revalidate`,
 * its store is an in-memory LRU scoped to one process, and the cache key
 * includes the build id — so every redeploy starts empty, and this site
 * redeploys several times a day. Any "just cache it for longer" answer is
 * therefore answering a different question.
 *
 * The failure this exists to stop is specific and was measured, not imagined:
 * roughly a minute into a backend outage the first request regenerates `/`;
 * because lib/db.tsx resolves a failure to a VALUE rather than throwing, that
 * regeneration *succeeds*, and the ISR entry — the good HTML built at deploy
 * time — is overwritten with the failure panel and served for the rest of the
 * outage. A crawler reads that. Returning last-known-good data means the
 * regeneration writes real (if older) rows and there is no poisoned state to
 * serve in the first place.
 *
 * Two tiers, deliberately:
 *
 *   SEED     imported statically from ./snapshots/*.json, so it is bundled and
 *            is present on every machine including a cold container and the
 *            build itself. This is what stops `next build` during an outage
 *            from baking a failure panel into shipped HTML — build output is
 *            the one thing that survives a redeploy, and no cacheLife value
 *            can reach it.
 *   RUNTIME  a directory named by ARCHIVE_SNAPSHOT_DIR, written on every
 *            successful read. Newer than the seed and survives a redeploy if
 *            it is a mounted volume. Entirely optional: with the variable
 *            unset, reads fall back to the seed and writes are a no-op.
 *
 * Verified safe inside a "use cache" scope: Next instruments `date`, `random`,
 * `node-crypto` and `web-crypto` in node-environment-extensions, but NOT `fs`.
 * The docs name `fs.readFileSync` explicitly as a predictable value that
 * completes during prerendering.
 *
 * What this does NOT do: make stale data look fresh. Every reader gets
 * `savedAt` and is expected to say so. See the `stale` flag in lib/db.tsx.
 */

export interface Snapshot<T> {
  /** ISO 8601, when the reading was taken. Always shown to the reader. */
  savedAt: string
  value: T
}

export type SnapshotName = "status" | "content-types" | "latest" | "sitemap-hosts"

/*
 * Statically imported rather than read from disk, and that is the point: a
 * bundled import is present whatever the Docker image layout or Next output
 * mode turns out to be, whereas a path like `lib/snapshots/x.json` is only
 * there if something copied it. Regenerate with scripts/seed-snapshots.ts.
 */
const SEEDS: Record<SnapshotName, Snapshot<unknown>> = {
  status: seedStatus as Snapshot<unknown>,
  "content-types": seedContentTypes as Snapshot<unknown>,
  latest: seedLatest as Snapshot<unknown>,
  /*
   * The sitemap's host list matters more than the others for the seed tier
   * specifically: app/sitemap.ts runs at BUILD time, so a build during a
   * backend outage would otherwise ship a sitemap of seven URLs instead of
   * ~480 and serve it until the next deploy.
   */
  "sitemap-hosts": seedSitemapHosts as Snapshot<unknown>,
}

/** Unset disables the runtime tier entirely; the seed still works. */
const RUNTIME_DIR = process.env.ARCHIVE_SNAPSHOT_DIR

/**
 * Suffix for the temp file an atomic write renames from.
 *
 * A counter and the pid rather than Math.random(), which Next patches through
 * its io() instrumentation. That call is a no-op inside a "use cache" scope, so
 * random would in fact be safe here — but not depending on that is cheaper than
 * having to re-derive it the next time someone reads this.
 */
let writeCounter = 0

const runtimePath = (name: SnapshotName): string | null =>
  RUNTIME_DIR ? join(RUNTIME_DIR, `${name}.json`) : null

const isSnapshot = (parsed: unknown): parsed is Snapshot<unknown> =>
  typeof parsed === "object"
  && parsed !== null
  && typeof (parsed as { savedAt?: unknown }).savedAt === "string"
  && "value" in parsed

/**
 * The newest usable reading, or null.
 *
 * Runtime tier first, then the bundled seed. Synchronous on purpose: it runs
 * once per cache fill, only on the failure path, and a sync read is what the
 * Cache Components docs call a predictable value — it cannot punch a dynamic
 * hole in a page that has to prerender.
 *
 * Never throws. A missing file, a bad mount, unreadable JSON and a truncated
 * write all mean the same thing to a caller: there is nothing better than the
 * failure you already have.
 */
export const readSnapshot = <T>(name: SnapshotName): Snapshot<T> | null => {
  const path = runtimePath(name)

  if (path) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (isSnapshot(parsed)) return parsed as Snapshot<T>
      console.error(`snapshot: ${path} is not a snapshot envelope; falling back to the seed`)
    } catch (error) {
      // ENOENT is the normal case before the first successful read, so it is
      // not worth a log line of its own; anything else is worth knowing about.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(`snapshot: could not read ${path}:`, error)
      }
    }
  }

  return (SEEDS[name] as Snapshot<T> | undefined) ?? null
}

/**
 * Record a good reading. Fire and forget — never awaited, never rejects.
 *
 * Written to a temp file and renamed, because rename is atomic within a
 * filesystem: a reader can see the old file or the new one, never a half
 * written one. A torn snapshot would be worse than no snapshot, since it is
 * read precisely when everything else has already failed.
 *
 * No-ops when ARCHIVE_SNAPSHOT_DIR is unset, which includes the build — so a
 * prerender cannot quietly write into the image and pass it off as runtime
 * data.
 */
export const writeSnapshot = (name: SnapshotName, value: unknown, savedAt: string): void => {
  const path = runtimePath(name)
  if (!path) return

  const temp = `${path}.${process.pid}.${writeCounter++}.tmp`
  const body = JSON.stringify({ savedAt, value } satisfies Snapshot<unknown>)

  try {
    mkdirSync(RUNTIME_DIR!, { recursive: true })
  } catch {
    // Racing another worker, or a read-only mount. writeFile reports it below.
  }

  void writeFile(temp, body, "utf8")
    .then(() => {
      renameSync(temp, path)
    })
    .catch((error) => {
      console.error(`snapshot: could not write ${path}:`, error)
    })
}

/**
 * Which tier is live, for a single line at startup.
 *
 * The runtime tier is a volume mount and an environment variable — configuration
 * no code can enforce — and its failure mode is silent: the site keeps working
 * and quietly serves data frozen at build time. Saying so once is the cheapest
 * defence against that going unnoticed for a month.
 */
export const snapshotTier = (): string =>
  RUNTIME_DIR
    ? `snapshot: runtime tier at ${RUNTIME_DIR} (seed fallback bundled)`
    : "snapshot: seed tier only — set ARCHIVE_SNAPSHOT_DIR to persist fresh readings across deploys"

/*
 * Said once at startup, because the runtime tier's failure is SILENT: a missing
 * volume or an unset variable breaks nothing, the site just quietly serves
 * figures frozen at the last build. That can go unnoticed for months.
 *
 * NOT during a build, though. "Module scope runs once per process" was true and
 * beside the point — `next build` forks a worker per core, so this printed
 * eight times into one build log and said nothing useful each time: writes are
 * a deliberate no-op at build (see writeSnapshot), so the runtime tier being
 * unset is the expected state there, not a warning.
 *
 * NEXT_PHASE is set to PHASE_PRODUCTION_BUILD in next/dist/build/index.js
 * before the static workers are forked, and they inherit the environment.
 */
if (process.env.NEXT_PHASE !== "phase-production-build") {
  console.info(snapshotTier())
}
