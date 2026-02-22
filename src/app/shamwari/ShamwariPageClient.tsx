"use client";

import { Suspense, lazy } from "react";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { ChatSkeleton } from "@/components/ui/skeleton";

const ExploreChatbot = lazy(() =>
  import("@/components/explore/ExploreChatbot").then((m) => ({ default: m.ExploreChatbot }))
);

/**
 * Full-viewport Shamwari chat page.
 *
 * Layout: fills the space between the sticky header (3.5rem) and the
 * fixed mobile bottom nav (4.5rem). On desktop (sm+) the bottom nav
 * is hidden so no bottom padding is needed.
 *
 * The chat input naturally sits at the bottom of the flex container,
 * which places it directly above the mobile navigation bar.
 */
export function ShamwariPageClient() {
  return (
    <main className="flex flex-col h-[calc(100dvh-3.5rem)] pb-[4.5rem] sm:pb-0">
      <div className="mx-auto w-full max-w-3xl flex-1 min-h-0 flex flex-col border-x border-border/50">
        <ChartErrorBoundary name="Shamwari Chat">
          <Suspense fallback={<ChatSkeleton className="h-full" />}>
            <ExploreChatbot />
          </Suspense>
        </ChartErrorBoundary>
      </div>
    </main>
  );
}
