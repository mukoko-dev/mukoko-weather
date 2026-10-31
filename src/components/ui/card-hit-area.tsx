import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Transparent hit area laid over a card (or a row of one) so the whole
 * surface opens a detail sheet without nesting interactive elements inside
 * a button. The parent must be `relative`. Anything that must stay tappable
 * on top of it (report pins, other actions) sits above with a higher z-index.
 * The visible control is the card itself, so this has no styling of its own.
 */
export function CardHitArea({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      className={cn(
        "absolute inset-0 z-[1] m-0 rounded-[var(--radius-card)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        className,
      )}
      {...props}
    />
  );
}
