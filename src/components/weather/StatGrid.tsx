import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface StatItem {
  label: string;
  value: ReactNode;
  /** Optional muted line under the value (units, a source, a caveat). */
  hint?: ReactNode;
  /** Text colour class for the value (e.g. a risk tone). Defaults to primary text. */
  tone?: string;
}

/** Column counts the grid supports. Literal classes, so Tailwind sees them. */
const COLUMN_CLASSES: Record<2 | 3 | 4, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
};

/**
 * A grid of labelled stat tiles (`<dl>` of `.meerkat` tiles): the label is a
 * `<dt>`, the value a `<dd>`, so assistive tech reads each pair together.
 */
export function StatGrid({
  items,
  columns = 2,
  className,
}: {
  items: StatItem[];
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  return (
    <dl className={cn("gap-2", COLUMN_CLASSES[columns], "grid", className)}>
      {items.map((item) => (
        <div key={item.label} className="meerkat">
          <dt className="dove">{item.label}</dt>
          <dd
            className={cn(
              "text-base font-medium",
              item.tone ?? "text-text-primary",
            )}
          >
            {item.value}
            {item.hint != null && (
              <span className="dove block">{item.hint}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
