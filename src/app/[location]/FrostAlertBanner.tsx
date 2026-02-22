import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import type { FrostAlert } from "@/lib/weather";

export function FrostAlertBanner({ alert }: { alert: FrostAlert }) {
  const variant = alert.risk === "severe" ? "frost" : "warning";

  const borderColor =
    alert.risk === "severe"
      ? "border-frost-severe"
      : alert.risk === "high"
        ? "border-earth"
        : "border-accent";

  const bgColor =
    alert.risk === "severe"
      ? "bg-frost-severe-bg"
      : alert.risk === "high"
        ? "bg-frost-high-bg"
        : "bg-frost-moderate-bg";

  const textColor =
    alert.risk === "severe"
      ? "text-frost-severe"
      : alert.risk === "high"
        ? "text-earth"
        : "text-accent";

  return (
    <Alert
      variant={variant}
      aria-live="assertive"
      className={`mb-6 ${borderColor} ${bgColor}`}
    >
      <AlertTitle className={textColor}>
        Frost {alert.risk === "severe" ? "Warning" : "Advisory"} — {alert.risk.toUpperCase()}
      </AlertTitle>
      <AlertDescription className={textColor}>{alert.message}</AlertDescription>
    </Alert>
  );
}
