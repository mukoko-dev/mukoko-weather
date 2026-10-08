import type { ReactNode } from "react";
import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";
import { BreadcrumbSkeleton } from "@/components/layout/Breadcrumb";
import { Footer } from "@/components/layout/Footer";

/**
 * Shared loading frame for the explore routes. Renders skeleton placeholders
 * for the header and breadcrumb (never the live Header, which is a client
 * component with nav state) and announces the page body as busy to screen
 * readers. Each loading.tsx supplies only its own body skeleton.
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
    <>
      <HeaderSkeleton />
      <BreadcrumbSkeleton />
      <main
        aria-label={mainLabel}
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:px-6 sm:pb-8 md:px-8"
      >
        <div role="status" aria-label="Loading" aria-busy="true">
          <span className="sr-only">{srText}</span>
          {children}
        </div>
      </main>
      <Footer />
    </>
  );
}
