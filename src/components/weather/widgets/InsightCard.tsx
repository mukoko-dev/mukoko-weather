import * as React from "react";
import { cn } from "@/lib/utils";

export type InsightCardSize = "square" | "wide" | "hero";

/**
 * Size → classes. `square` is a half-width grid cell with a minimum height
 * (never a fixed 1:1 box: at phone width that is ~170px and a heading, a
 * value and a sentence do not fit, so they overlapped). The row stretches to
 * the tallest tile so every card in a row still lines up. `wide` spans the full row at its natural
 * height. `hero` spans the full row and is square on mobile, capped on desktop.
 */
export function insightCardSizeClass(size: InsightCardSize = "square"): string {
  switch (size) {
    case "wide":
      return "col-span-full";
    case "hero":
      return "col-span-full aspect-square max-h-[var(--size-insight-hero-max)] w-full";
    case "square":
    default:
      return "min-h-[var(--size-insight-square-min)]";
  }
}

export interface InsightCardProps {
  icon: React.ReactNode;
  /** Uppercase eyebrow label, e.g. "WIND". */
  label: string;
  /** The visual or value block. */
  children: React.ReactNode;
  /** One line of insight shown at the bottom of the card. */
  sentence?: string;
  /** Id for the heading; the section is labelled by it. */
  headingId: string;
  size?: InsightCardSize;
}

/** Layer-1 shell shared by every metric visual. Pure presentation. */
export function InsightCard({
  icon,
  label,
  children,
  sentence,
  headingId,
  size = "square",
}: InsightCardProps) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "acacia flex min-w-0 flex-col gap-3",
        insightCardSizeClass(size),
      )}
      data-size={size}
    >
      <header className="flex items-center gap-1.5">
        <span className="text-text-tertiary" aria-hidden="true">
          {icon}
        </span>
        <h3 id={headingId} className="hornbill text-sm">
          {label}
        </h3>
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
        {children}
      </div>
      {sentence && <p className="dove leading-snug">{sentence}</p>}
    </section>
  );
}

/**
 * 2 columns, 4 once the grid's OWN column is wide enough (a container query,
 * not the viewport). At the viewport's `lg` (1024px, a tablet) the main column
 * is only about two thirds of the screen, so four square tiles were ~150px
 * wide and their content overflowed. `@3xl` is 48rem of column width.
 * wide/hero cards span the row.
 */
export function InsightGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="@container">
      <div
        className={cn(
          "grid grid-cols-2 gap-[var(--space-stack)] @3xl:grid-cols-4",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function InsightCardSkeleton({
  size = "square",
}: {
  size?: InsightCardSize;
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("chameleon min-w-0", insightCardSizeClass(size))}
      data-size={size}
    />
  );
}
