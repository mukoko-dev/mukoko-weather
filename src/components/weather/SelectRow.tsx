import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A single-choice row (a radio in a radiogroup), drawn with the `.bushbuck`
 * place-row surface. The selected row takes the primary edge and tint and a
 * check mark at its trailing edge; the choice is announced via `aria-checked`.
 *
 * @example
 * <SelectRow selected={theme === "dark"} onSelect={() => setTheme("dark")}>
 *   <span>Dark</span>
 * </SelectRow>
 */
export function SelectRow({
  selected,
  onSelect,
  children,
  className,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-active={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn("bushbuck press-scale w-full px-4 py-3", className)}
    >
      {children}
      {selected && (
        <span
          className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary animate-[scale-in_200ms_ease-out]"
          aria-hidden="true"
        >
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            className="stroke-primary-foreground"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      )}
    </button>
  );
}
