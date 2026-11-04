/**
 * One card on the `/display` kiosk: a labelled `<section>` on a fauna card
 * surface with a heading. `titleHidden` keeps the heading for screen readers
 * only, for panels whose content already says what they are.
 *
 * `tone` picks the surface: `baobab` is the primary card (the current
 * conditions), `acacia` the quieter one. Padding and layout come in through
 * `className`.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  titleId,
  title,
  action,
  tone = "acacia",
  titleHidden = false,
  titleClassName,
  className,
  children,
}: {
  titleId: string;
  title: string;
  action?: ReactNode;
  tone?: "baobab" | "acacia";
  titleHidden?: boolean;
  titleClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={titleId} className={cn(tone, "p-5", className)}>
      <h2
        id={titleId}
        className={titleHidden ? "sr-only" : cn("giraffe", titleClassName)}
      >
        {title}
      </h2>
      {action}
      {children}
    </section>
  );
}
