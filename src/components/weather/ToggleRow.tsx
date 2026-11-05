import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * An on/off row (a switch), drawn with the same `.bushbuck` row surface as
 * `SelectRow`. The whole row is the control (a 49px hit region, the Bundu
 * floor), the state is announced through `role="switch"` / `aria-checked` and
 * is never colour alone: the track moves and the word "On" or "Off" is printed.
 *
 * `description` is wired to the switch with `aria-describedby`, so a screen
 * reader hears what the switch does along with its name. `id` must be unique on
 * the page.
 *
 * @example
 * <ToggleRow id="alert-frost" label="Frost" description="…" checked={on}
 *   onChange={(next) => setOn(next)} />
 */
export function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
  className,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const describedBy = description ? `${id}-about` : undefined;
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      data-active={checked ? "true" : undefined}
      onClick={() => onChange(!checked)}
      className={cn(
        "bushbuck press-scale w-full justify-between gap-3 px-[var(--inset-floor)] py-3 disabled:opacity-50",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-base font-medium text-text-primary">
          {label}
        </span>
        {description && (
          <span
            id={describedBy}
            className="mt-0.5 block text-sm text-text-tertiary"
          >
            {description}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2" aria-hidden="true">
        <span className="text-sm text-text-secondary">
          {checked ? "On" : "Off"}
        </span>
        <span
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full border transition-colors",
            checked
              ? "border-primary bg-primary"
              : "border-[color:var(--float-border)] bg-surface-dim",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 rounded-full transition-transform",
              checked
                ? "translate-x-[1.375rem] bg-primary-foreground"
                : "translate-x-1 bg-text-secondary",
            )}
          />
        </span>
      </span>
    </button>
  );
}
