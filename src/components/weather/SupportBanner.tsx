"use client";

import { Card } from "@/components/ui/card";

/**
 * SupportBanner — Buy Me a Coffee inline support card.
 * Placed as a LazySection + ChartErrorBoundary on the location page so a
 * crash here never affects any other section.
 * Uses the official BMC brand yellow (#FFDD00) via --color-bmc CSS token.
 */
export function SupportBanner() {
  return (
    <section aria-labelledby="support-banner-heading">
      <Card className="border-bmc/40 bg-bmc/10 p-0 shadow-sm">
        <a
          href="https://www.buymeacoffee.com/bryany"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-4 rounded-[var(--radius-card)] px-5 py-4 transition-colors hover:bg-bmc/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bmc"
          aria-label="Support mukoko weather — Buy Me a Coffee"
        >
          {/* BMC yellow dot accent */}
          <div
            className="h-3 w-3 shrink-0 rounded-full bg-bmc"
            aria-hidden="true"
          />

          <div className="min-w-0 flex-1">
            <p
              id="support-banner-heading"
              className="text-base font-semibold text-text-primary"
            >
              Love the weather updates?
            </p>
            <p className="text-base text-text-secondary">
              Help keep the AI behind it running — every coffee counts!
            </p>
          </div>

          {/* BMC yellow badge — visible tablet+ */}
          <span
            className="hidden shrink-0 rounded-[var(--radius-badge)] bg-bmc px-3 py-1.5 text-base font-bold text-bmc-fg sm:block"
            aria-hidden="true"
          >
            Buy me a coffee ☕
          </span>
        </a>
      </Card>
    </section>
  );
}
