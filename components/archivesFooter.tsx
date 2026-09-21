import ErrorBoundary from "./ErrorBoundary/ErrorBoundary"
import SystemStatsServer from "./SystemStats/SystemStatsServer"

/*
 * No <Suspense>, for the same reason as RecentArchivesClient: SystemStatsServer
 * is cached, so its result belongs in the static shell, and a boundary around it
 * would ship the fallback instead and stream the numbers afterwards.
 *
 * SystemStatsLoading is still exported from SystemStatsServer — nothing renders
 * it now, but it is the right fallback the day these stats become per-request.
 */
export const ArchivesFooter = () => (
  <ErrorBoundary>
    <SystemStatsServer />
  </ErrorBoundary>
)
