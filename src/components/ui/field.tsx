/**
 * A labelled form field: the label, an optional hint, then the control.
 *
 * The control is passed as `children` and keeps its own classes. Text inputs
 * use `FIELD_CONTROL_CLASS` so every field has the same height and spacing.
 * `labelClassName` replaces the default muted label (e.g. a visually hidden one).
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The shared text-input look: a fauna control, touch-target height, spacing under the label. */
export const FIELD_CONTROL_CLASS = "crane mt-1 min-h-[var(--touch-target-min)]";

const DEFAULT_LABEL_CLASS = "block text-base font-medium text-text-secondary";

export function Field({
  label,
  htmlFor,
  hint,
  labelClassName,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  labelClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("block", className)}>
      <label
        htmlFor={htmlFor}
        className={labelClassName ?? DEFAULT_LABEL_CLASS}
      >
        {label}
      </label>
      {hint && <p className="dove mt-1">{hint}</p>}
      {children}
    </div>
  );
}
