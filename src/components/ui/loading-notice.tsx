import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

/**
 * A spinner with a visible status line, in a `role="status"` polite region so
 * screen readers announce it. The label is the text a sighted reader sees, so
 * the announcement and the screen match.
 *
 * @example
 * <LoadingNotice label="Loading reports..." />
 * <LoadingNotice label="Analyzing 30-day history..." textClassName="text-base text-text-secondary" />
 */
export function LoadingNotice({
  label,
  className,
  textClassName = "dove",
  spinnerClassName,
}: {
  label: string;
  className?: string;
  textClassName?: string;
  spinnerClassName?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-2", className)}
    >
      <Spinner className={spinnerClassName} />
      <span className={textClassName}>{label}</span>
    </div>
  );
}
