/**
 * Where each EXTERNAL forecast model comes from, and the credit it requires.
 *
 * `map-sources.ts` is the single source of truth for map overlays; this is its
 * counterpart for forecast models that are not Open-Meteo's: today only Apple
 * Weather (WeatherKit). Every place Apple data can be on screen reads its
 * credit from here (the My Weather picker, the model-comparison chart, the
 * page footer, the dashboard when it is the baseline), so the wording and the
 * link cannot drift. Never hand-write a credit string.
 *
 * Apple's terms (developer.apple.com/weatherkit, checked 2026-11-01): wherever
 * Apple weather data is displayed, "clearly display the Apple Weather trademark
 * (Weather), as well as the legal link to other data sources". Data that is
 * "derived from weather data from Apple and transformed" (value-added) is
 * attributed to "Weather" "along with a notice that the data provided by Apple
 * has been modified". A series plotted as it came, converted only in unit, is
 * not value-added; a baseline (nulls filled from another model, insights
 * derived from the values) is.
 *
 * Plain data and pure functions only. The Rust side holds the same constants
 * (`weather_core::weatherkit`); `forecast-sources.test.ts` pins the two.
 */

import { getFeatureFlag } from "./feature-flags";

export type ForecastProviderId = "apple-weatherkit";

/** How the data is shown, which decides whether the modified notice is due. */
export type CreditUse = "plotted" | "baseline";

export interface ForecastProvider {
  id: ForecastProviderId;
  /** The model id (`selectedForecastModel`, `?model=`, `models=`). */
  modelId: string;
  /** What a person reads as the model's name. */
  label: string;
  /** The trademark text the provider's terms name: "Apple Weather trademark (Weather)". */
  mark: string;
  /** The provider's legal page for its data sources. Required with the mark. */
  href: string;
  /** Required next to a baseline (value-added data). */
  modifiedNotice: string;
  /**
   * `X-Weather-Provider` of an answer that IS this provider's forecast. The
   * Open-Meteo models are `open-meteo:<id>`; an external provider is its own.
   */
  servedProvider: string;
  /**
   * The official mark as an image (Apple serves it from its Attribution
   * endpoint). `null` until it is wired: the credit is then the trademark
   * text. The feature flag must not be turned on while this is `null`
   * (`forecast-sources.test.ts` enforces it), because Apple asks for its mark.
   */
  markAssetUrl: string | null;
  licence: string;
}

export const APPLE_WEATHERKIT_MODEL = "apple_weatherkit";

export const FORECAST_PROVIDERS: Readonly<
  Record<ForecastProviderId, ForecastProvider>
> = {
  "apple-weatherkit": {
    id: "apple-weatherkit",
    modelId: APPLE_WEATHERKIT_MODEL,
    label: "Apple Weather",
    mark: "Weather",
    href: "https://developer.apple.com/weatherkit/data-source-attribution/",
    modifiedNotice: "Data provided by Apple has been modified.",
    servedProvider: "apple-weatherkit",
    markAssetUrl: null,
    licence:
      "Apple Developer Program: WeatherKit (500,000 calls a month included); attribution required",
  },
};

/** The external provider that serves a model id, if it is not an Open-Meteo model. */
export function providerForModel(
  modelId: string | null | undefined,
): ForecastProvider | undefined {
  return Object.values(FORECAST_PROVIDERS).find((p) => p.modelId === modelId);
}

/**
 * Whether a model is served by someone other than Open-Meteo. Such an id must
 * never be sent to Open-Meteo (it answers an unknown model with a 400).
 */
export function isExternalForecastModel(
  modelId: string | null | undefined,
): boolean {
  return providerForModel(modelId) !== undefined;
}

/**
 * The `X-Weather-Provider` value of an answer that is `model`'s forecast:
 * `open-meteo:<model>` for an Open-Meteo model, the provider's own otherwise.
 */
export function servedProviderFor(model: string): string {
  return providerForModel(model)?.servedProvider ?? `open-meteo:${model}`;
}

/** One credit line, ready to render. */
export interface ForecastCredit {
  providerId: ForecastProviderId;
  /** The model's name, for context ("Apple Weather"). */
  label: string;
  /** The trademark text. */
  mark: string;
  /** The legal link. */
  href: string;
  /** The modified notice, only when the use is a baseline. */
  notice: string | null;
  markAssetUrl: string | null;
}

/** The credit due for a model shown in this way, or `null` (no credit is due). */
export function creditFor(
  modelId: string | null | undefined,
  use: CreditUse,
): ForecastCredit | null {
  const p = providerForModel(modelId);
  if (!p) return null;
  return {
    providerId: p.id,
    label: p.label,
    mark: p.mark,
    href: p.href,
    notice: use === "baseline" ? p.modifiedNotice : null,
    markAssetUrl: p.markAssetUrl,
  };
}

/**
 * The credits due for a set of models on screen, one per provider. A provider
 * shown as a baseline anywhere in the set carries the notice.
 */
export function creditsFor(
  models: readonly string[],
  use: CreditUse,
): ForecastCredit[] {
  const seen = new Map<ForecastProviderId, ForecastCredit>();
  for (const m of models) {
    const c = creditFor(m, use);
    if (c && !seen.has(c.providerId)) seen.set(c.providerId, c);
  }
  return [...seen.values()];
}

/**
 * Whether Apple Weather is offered at all. Off until the Servers API origin
 * (Gwaihir) serves it and the owner has confirmed the Developer Program terms:
 * a picker entry that does nothing would be a lie. Honours the dev override
 * (`localStorage ff:apple_weatherkit`).
 */
export function appleWeatherEnabled(): boolean {
  return getFeatureFlag("apple_weatherkit");
}
