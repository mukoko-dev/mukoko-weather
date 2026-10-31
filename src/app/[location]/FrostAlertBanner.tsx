import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { FROST_BANNER_CLASSES } from "@/lib/frost-styles";
import type { FrostAlert } from "@/lib/weather";

export function FrostAlertBanner({ alert }: { alert: FrostAlert }) {
  const { border, bg } = FROST_BANNER_CLASSES[alert.risk];

  return (
    <Alert
      variant="frost"
      aria-live="assertive"
      className={`mb-7 animate-fade-in-down ${border} ${bg}`}
    >
      <AlertTitle>
        Frost {alert.risk === "severe" ? "Warning" : "Advisory"} —{" "}
        {alert.risk.toUpperCase()}
      </AlertTitle>
      <AlertDescription>{alert.message}</AlertDescription>
    </Alert>
  );
}
