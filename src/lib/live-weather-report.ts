/**
 * Report a failed live-weather fetch (#414). One line to the console for
 * whoever is debugging, one GA4 event for the error-rate dashboard.
 *
 * What is sent is the route, the HTTP status, the failure kind, the attempt
 * number and the place's slug coarsened by `logWarn`/`reportProviderFailure`
 * (a spot's name and geohash are cut down): never coordinates, never a URL.
 */

import { logWarn, reportProviderFailure } from "./observability";
import type { WorkerFailure } from "./worker-data";

export interface LiveWeatherReportSinks {
  warn: typeof logWarn;
  analytics: typeof reportProviderFailure;
}

export function reportLiveWeatherFailure(
  slug: string,
  failure: WorkerFailure,
  attempt: number,
  sinks: LiveWeatherReportSinks = {
    warn: logWarn,
    analytics: reportProviderFailure,
  },
): void {
  try {
    sinks.warn({
      source: "client-fetch",
      location: slug,
      message: `live weather fetch failed: ${failure.kind}`,
      meta: {
        route: "weather",
        status: failure.status,
        kind: failure.kind,
        attempt,
        ...(failure.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: failure.retryAfterSeconds }
          : {}),
      },
    });
    sinks.analytics("weather-api", failure.kind, slug);
  } catch {
    // Reporting must never be the thing that breaks the page.
  }
}
