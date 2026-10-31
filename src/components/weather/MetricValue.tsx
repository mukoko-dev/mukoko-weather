import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The large numeral on a metric card or detail sheet (a reading such as an
 * AQI, UV index or humidity). Tabular figures keep the digits from jittering
 * as values update. `unit` renders as a smaller suffix beside the number.
 */
export function MetricValue({
  children,
  unit,
  className,
}: {
  children: ReactNode;
  unit?: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary",
        className,
      )}
    >
      {children}
      {unit != null && (
        <span className="ml-1 text-base font-medium text-text-secondary">
          {unit}
        </span>
      )}
    </p>
  );
}
