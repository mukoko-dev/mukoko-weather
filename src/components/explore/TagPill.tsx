import type { ReactNode } from "react";

/** A location's tag, shown as a small primary-tinted pill. */
export function TagPill({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-base font-medium text-primary">
      {children}
    </span>
  );
}
