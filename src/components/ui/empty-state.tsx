import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Empty-state card for lists with no items ("No locations available here
 * yet."). Token-only styling; the caller controls spacing via className.
 *
 * Optional `title` sets a bold line above the message, and `actions` renders
 * a row of follow-up controls (pass Button or fauna-class links) below it.
 * Kept deliberately minimal — the registry's shadcn empty-state block uses a
 * different token set and a large icon well that doesn't fit list cards.
 */
export function EmptyState({
  children,
  title,
  actions,
  className,
}: {
  children?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] bg-surface-card p-6 text-center text-text-tertiary",
        className,
      )}
    >
      {title && <p className="font-semibold text-text-primary">{title}</p>}
      {children && <p>{children}</p>}
      {actions && (
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
