import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Inline error notice for a failed section: a `role="alert"` region with the
 * message and, when `onRetry` is given, a retry control at the 48px
 * touch-target minimum.
 *
 * - `tone="severe"` (default): a severity-coloured Alert, for a failed request
 *   the reader must act on.
 * - `tone="quiet"`: a neutral card (`.acacia`), for a section that could not
 *   draw. The surrounding page is unaffected, so nothing shouts.
 *
 * @example
 * <InlineError message="Couldn't load the forecast." onRetry={reload} />
 */
export function InlineError({
  message,
  onRetry,
  retryLabel = "Try again",
  tone = "severe",
  variant = "severe",
  className,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  tone?: "severe" | "quiet";
  variant?: "severe" | "warning" | "frost";
  className?: string;
}) {
  if (tone === "quiet") {
    return (
      <div
        role="alert"
        className={cn(
          "acacia text-center text-base text-text-tertiary",
          className,
        )}
      >
        <p>{message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="dikdik mt-2">
            {retryLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <Alert variant={variant} className={cn(className)}>
      <AlertDescription className="mt-0 flex flex-wrap items-center justify-between gap-3">
        <span>{message}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="impala-sm">
            {retryLabel}
          </button>
        )}
      </AlertDescription>
    </Alert>
  );
}
