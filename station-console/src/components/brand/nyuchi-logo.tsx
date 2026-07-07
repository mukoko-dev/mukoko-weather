import { cn } from "@/lib/utils";

/**
 * Brand wordmark — lowercase always (doctrine: `mukoko`, never `Mukoko`).
 * API-compatible with the registry NyuchiLogo (size + suffix) so the
 * vendored shell components render unchanged.
 */
export function NyuchiLogo({
  size = 24,
  suffix,
  className,
}: {
  size?: number;
  suffix?: string;
  className?: string;
}) {
  return (
    <span
      data-slot="nyuchi-logo"
      className={cn("flex items-baseline gap-1.5 font-serif", className)}
    >
      <span
        className="font-semibold leading-none text-foreground"
        style={{ fontSize: size }}
      >
        mukoko
      </span>
      {suffix && (
        <span className="text-sm leading-none text-muted-foreground">
          {suffix}
        </span>
      )}
    </span>
  );
}
