import PageHeader from "@/components/PageHeader/PageHeader"
import { SkeletonBar, SkeletonRegion } from "@/components/Skeleton/Skeleton"

export default function SearchLoading() {
  return (
    <SkeletonRegion label="Loading search results">
      <PageHeader title="Loading archived captures" subtitle="Preparing the search results" />
      <div style={{ display: "grid", gap: "1rem", padding: "1.5rem 0" }}>
        <SkeletonBar width="100%" height="2.5rem" />
        <SkeletonBar width="40%" height="1.25rem" />
        <SkeletonBar width="100%" height="5rem" />
        <SkeletonBar width="100%" height="5rem" />
        <SkeletonBar width="100%" height="5rem" />
      </div>
    </SkeletonRegion>
  )
}
