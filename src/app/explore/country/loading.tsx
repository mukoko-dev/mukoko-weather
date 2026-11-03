import { CardSkeleton } from "@/components/ui/skeleton";
import {
  PageHeaderSkeleton,
  SkeletonStack,
} from "@/components/layout/PageShell";
import { ExploreLoadingShell } from "../ExploreLoadingShell";

export default function ExploreCountryLoading() {
  return (
    <ExploreLoadingShell
      mainLabel="Loading countries"
      srText="Loading countries…"
    >
      <PageHeaderSkeleton />
      <SkeletonStack count={9} className="herd-grid">
        {() => <CardSkeleton />}
      </SkeletonStack>
    </ExploreLoadingShell>
  );
}
