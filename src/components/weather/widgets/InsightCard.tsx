import * as React from "react";
import { cn } from "@/lib/utils";

export type InsightCardSize = "square" | "wide" | "hero";

/**
 * Size → classes. `square` is a half-width grid cell with a 1:1 box so every
 * card in a 2-column grid lines up. `wide` spans the full row at its natural
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
      return "aspect-square";
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

/** 2 columns on mobile, 4 on large screens. wide/hero cards span the row. */
export function InsightGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-[var(--space-stack)] lg:grid-cols-4",
        className,
      )}
    >
      {children}
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
