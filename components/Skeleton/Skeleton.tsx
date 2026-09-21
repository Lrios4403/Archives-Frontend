import styles from "./Skeleton.module.css"

interface SkeletonBarProps {
  /** Any CSS length or percentage. */
  width?: string
  height?: string
  /** Extra class, so a bar can adopt the real component's layout class. */
  className?: string
}

/**
 * One shimmering placeholder block.
 *
 * Presentational and server-renderable, so skeletons ship no client JS and can
 * be used as Suspense fallbacks in the static shell.
 */
export function SkeletonBar({ width = "100%", height = "1rem", className = "" }: SkeletonBarProps) {
  return (
    <span
      className={`${styles.bar} ${styles.inline} ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  )
}

/**
 * Wrapper that tells assistive tech a region is still loading, so screen readers
 * announce it once rather than reading out every placeholder.
 */
export function SkeletonRegion({
  label = "Loading",
  children,
}: {
  label?: string
  children: React.ReactNode
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      {children}
    </div>
  )
}
