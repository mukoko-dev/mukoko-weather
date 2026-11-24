import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { DismissibleBanner } from "@/components/ui/dismissible-banner";
import { FROST_BANNER_CLASSES } from "@/lib/frost-styles";
import type { FrostAlert } from "@/lib/weather";

/**
 * The frost warning or advisory, as a banner a person can close. Closing it
 * lasts the rest of the tab's session; a different risk or a different message
 * is a different banner and shows again.
 *
 * `className` is the banner's own spacing (it sits in a stack on the place
 * page, which spaces it; the other pages leave a gap below it).
 */
export function FrostAlertBanner({
  alert,
  className = "mb-7",
}: {
  alert: FrostAlert;
  className?: string;
}) {
  const { border, bg } = FROST_BANNER_CLASSES[alert.risk];
  const title = `Frost ${alert.risk === "severe" ? "Warning" : "Advisory"}`;

  return (
    <DismissibleBanner
      id={`frost:${alert.risk}:${alert.message}`}
      remember="session"
      closeLabel={`Dismiss ${title.toLowerCase()}`}
      className={`animate-fade-in-down ${className}`}
    >
      <Alert
        variant="frost"
        aria-live="assertive"
        className={`pr-12 ${border} ${bg}`}
      >
        <AlertTitle>
          {title} — {alert.risk.toUpperCase()}
        </AlertTitle>
        <AlertDescription>{alert.message}</AlertDescription>
      </Alert>
    </DismissibleBanner>
  );
}
