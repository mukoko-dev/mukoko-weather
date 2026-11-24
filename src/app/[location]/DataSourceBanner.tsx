import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { DismissibleBanner } from "@/components/ui/dismissible-banner";
import { ForecastCredit } from "@/components/ui/forecast-credit";
import { currentSourceCredit } from "@/lib/forecast-sources";

/**
 * The notice for observations the server used in `current` (NEA in Singapore,
 * #596), as an information banner a person can close (owner, 2026-11-23: the
 * Singapore information belongs in the alert banner, not on a line by itself).
 *
 * The text is the licence's own, read from `forecast-sources.ts` through
 * `ForecastCredit` and never hand-written here: the Singapore Open Data
 * Licence asks for that statement and a link to the licence. Nothing is drawn
 * for a source with no credit due, or when the server did not use the
 * observations. Closing it lasts the rest of the tab's session, so it shows
 * again on the next visit.
 */
export function DataSourceBanner({
  source,
  className = "mb-6",
}: {
  /** `current_overlay.source` of the data on screen. */
  source: string | null | undefined;
  /** The banner's own spacing: the place page spaces its stack itself. */
  className?: string;
}) {
  const credit = currentSourceCredit(source);
  if (!credit) return null;
  return (
    <DismissibleBanner
      id={`source:${credit.id}`}
      remember="session"
      closeLabel="Dismiss data source notice"
      className={className}
    >
      <Alert variant="info" role="status" aria-live="polite" className="pr-12">
        <AlertTitle>Data source</AlertTitle>
        <AlertDescription>
          <ForecastCredit
            models={[]}
            use="plotted"
            currentSource={credit.id}
            className="text-text-secondary"
          />
        </AlertDescription>
      </Alert>
    </DismissibleBanner>
  );
}
