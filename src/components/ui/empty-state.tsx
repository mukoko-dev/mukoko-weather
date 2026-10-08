import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Empty-state card for lists with no items ("No locations available here
 * yet."). Token-only styling; the caller controls spacing via className.
 * Kept deliberately minimal — the registry's shadcn empty-state block uses a
 * different token set and a large icon well that doesn't fit list cards.
 */
export function EmptyState({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] bg-surface-card p-6 text-center text-text-tertiary",
        className,
      )}
    >
      <p>{children}</p>
    </div>
  );
}
