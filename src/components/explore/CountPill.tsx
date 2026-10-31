import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A number in a primary-tinted pill (how many places a category or province holds). */
export function CountPill({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-base font-medium text-primary",
        className,
      )}
    >
      {children}
    </span>
  );
}
