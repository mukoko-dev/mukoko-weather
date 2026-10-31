import type { ReactNode } from "react";
import { PageShellSkeleton } from "@/components/layout/PageShell";

/**
 * Shared loading frame for the explore routes: the PageShell skeleton twin
 * (header, breadcrumb, wide main column, footer) so a loader and its page
 * share one frame. Each loading.tsx supplies only its own body skeleton.
 */
export function ExploreLoadingShell({
  mainLabel,
  srText,
  children,
}: {
  mainLabel: string;
  srText: string;
  children: ReactNode;
}) {
  return (
    <PageShellSkeleton width="wide" breadcrumb label={mainLabel}>
      <div aria-busy="true">
        <span className="sr-only">{srText}</span>
        {children}
      </div>
    </PageShellSkeleton>
  );
}
