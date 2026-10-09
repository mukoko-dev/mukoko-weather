"use client";

/**
 * SupportBanner — Buy Me a Coffee inline support card.
 * Placed as a LazySection + ChartErrorBoundary on the location page so a
 * crash here never affects any other section.
 * Uses the official BMC brand yellow (#FFDD00) via --color-bmc CSS token.
 */
export function SupportBanner() {
  return (
    <section aria-labelledby="support-banner-heading">
      <div className="acacia border-bmc/40 bg-bmc/10 p-0 shadow-sm">
        <a
          href="https://www.buymeacoffee.com/bryany"
          target="_blank"
          rel="noopener noreferrer"
          className="group block rounded-[var(--radius-card)] p-[var(--space-card)] transition-colors hover:bg-bmc/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bmc"
          aria-label="Support mukoko weather — Buy Me a Coffee"
        >
          <div className="flex items-center gap-3">
            {/* BMC yellow dot accent */}
            <div
              className="h-3 w-3 shrink-0 rounded-full bg-bmc"
              aria-hidden="true"
            />
            <p
              id="support-banner-heading"
              className="text-base font-semibold text-text-primary"
            >
              Love the weather updates?
            </p>
          </div>

          <p className="mt-1.5 text-base text-text-secondary">
            Help keep the AI behind it running — every coffee counts!
          </p>

          {/* BMC yellow badge */}
          <span
            className="mt-3 inline-block rounded-[var(--radius-badge)] bg-bmc px-3 py-1.5 text-base font-bold text-bmc-fg"
            aria-hidden="true"
          >
            Buy me a coffee ☕
          </span>
        </a>
      </div>
    </section>
  );
}
