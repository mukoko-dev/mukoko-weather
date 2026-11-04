/**
 * What the "live weather" banner says, and when (#414).
 *
 * It used to be tied to "the server sent the seasonal estimate AND no model
 * baseline came back", so one failed client fetch kept it up for good. It now
 * follows the data on screen:
 *
 * - `fallback`: what is on screen is the seasonal estimate (the Worker's
 *   `X-Weather-Provider: fallback`). It clears the moment any fetch brings
 *   live data.
 * - `stale`: what is on screen is a copy kept on this device, older than its
 *   freshness window, and a refresh has not worked.
 *
 * The reason is shown in plain words when it is known. Pure: the dashboard
 * passes in what it knows; air quality and every other section are not inputs,
 * so they cannot move the banner.
 */

import type { LiveFetchState } from "./live-fetch";

export interface BannerInput {
  /** The data on screen is the seasonal estimate. */
  fallback: boolean;
  /** The data on screen is a device copy older than its freshness window. */
  stale: boolean;
  /** The state of the dashboard's live fetch. */
  live: LiveFetchState;
  /**
   * The Worker answered with a stored forecast past its freshness because
   * every provider failed (`baseline.stale`). It is shown, and said so.
   */
  serverStale?: boolean;
}

export interface BannerView {
  show: boolean;
  variant: "fallback" | "stale";
  title: string;
  /** What the visitor is looking at instead. */
  message: string;
  /** Why, when known; null when there is nothing useful to say. */
  reason: string | null;
  /** Whether the "Try again" button should be offered (not while one runs). */
  canRetry: boolean;
}

const TITLES = {
  fallback: "Live weather data temporarily unavailable",
  stale: "This forecast may be out of date",
} as const;

const MESSAGES = {
  fallback: "Showing seasonal estimates for this location.",
  stale: "Showing the last forecast saved on this device.",
  serverStale: "Showing the last forecast we received for this location.",
} as const;

function reasonFor(
  live: LiveFetchState,
  variant: "fallback" | "stale",
): string | null {
  if (live.status === "loading" && !live.failure) {
    return "Checking for live data";
  }
  const retrying = live.status === "retrying" || live.status === "loading";
  switch (live.failure?.kind) {
    case "rate_limited":
      return retrying
        ? "Busy right now, retrying"
        : "Busy right now. Try again in a moment.";
    case "offline":
      return variant === "stale"
        ? "You're offline: showing the last forecast"
        : "You're offline: showing seasonal estimates";
    case "timeout":
    case "server":
      return retrying
        ? "The forecast service is slow, retrying"
        : "The forecast service is slow. Try again in a moment.";
    default:
      return null;
  }
}

export function weatherBanner({
  fallback,
  stale,
  live,
  serverStale = false,
}: BannerInput): BannerView {
  const variant = fallback ? "fallback" : "stale";
  const trouble = live.status === "retrying" || live.status === "failed";
  const show = fallback || serverStale || (stale && trouble);
  return {
    show,
    variant,
    title: TITLES[variant],
    message:
      variant === "stale" && serverStale && !stale
        ? MESSAGES.serverStale
        : MESSAGES[variant],
    reason: show ? reasonFor(live, variant) : null,
    canRetry: live.status !== "loading",
  };
}
