import { creditsFor, type CreditUse } from "@/lib/forecast-sources";
import { cn } from "@/lib/utils";

/**
 * The credit an external forecast provider requires wherever its data can be
 * on screen: the My Weather picker, the model-comparison chart, the page
 * footer and the dashboard when the provider is the baseline. One component,
 * one wording, read from `forecast-sources.ts` (never hand-written).
 *
 * Today that is Apple Weather. Apple asks for its trademark and the legal link
 * to its data sources wherever its data is shown, and, for value-added data,
 * a notice that the data has been modified. `use="baseline"` adds the notice
 * (the baseline fills gaps from another model and derives insights from the
 * values); `use="plotted"` is a series shown as it came.
 *
 * Renders nothing for models no credit is due for (every Open-Meteo model:
 * the footer credits those). Server- and client-safe: no hooks. Links open in
 * a new tab with a full touch target (`.dik-dik`), prose-link style
 * (`.sunbird`); the text is the muted `.dove`.
 */
export function ForecastCredit({
  models,
  use,
  className,
}: {
  /** The model ids on screen; only those with a provider credit render. */
  models: readonly string[];
  use: CreditUse;
  className?: string;
}) {
  const credits = creditsFor(models, use);
  if (credits.length === 0) return null;
  return (
    <ul
      className={cn("dove space-y-1", className)}
      aria-label="Forecast data sources"
      data-forecast-credit
    >
      {credits.map((c) => (
        <li key={c.providerId} data-forecast-provider={c.providerId}>
          {/* The trademark text. Apple's official mark image replaces it when
              `markAssetUrl` is wired (forecast-sources.ts). */}
          <span className="font-medium">{c.label}</span>
          {" · "}
          <a
            href={c.href}
            target="_blank"
            rel="noopener noreferrer"
            className="sunbird dik-dik"
          >
            Other data sources
          </a>
          {c.notice && <span>{` · ${c.notice}`}</span>}
        </li>
      ))}
    </ul>
  );
}
