"use client";

import { FloatingStack } from "@/components/ui/floating-stack";
import { PlaceLoadNotice } from "@/components/weather/PlaceLoadNotice";
import type { PlaceState } from "@/lib/place-controller";

/**
 * Which notice a page that fetches its own weather should float, if any.
 *
 * One at a time: the final "Couldn't load" (retries spent) wins; the calm
 * "Still trying…" line is only for a page with nothing stored to show while
 * the retries run (a stored copy on screen never shows it).
 */
export function pageWeatherNoticeKind(
  state: Pick<PlaceState, "failed" | "slow" | "view">,
): "failed" | "slow" | null {
  if (state.failed) return "failed";
  if (state.slow && !state.view) return "slow";
  return null;
}

/**
 * The floating weather-load notice for `/[location]/forecast` and
 * `/[location]/atmosphere`: the same card, copy and retry as the place page's
 * (`PlaceLoadNotice`), over the page's own skeleton, so nothing in the flow
 * moves. "Try again" is a new request, never a reload.
 */
export function PageWeatherNotice({
  state,
  retry,
}: {
  state: PlaceState;
  retry: () => void;
}) {
  const kind = pageWeatherNoticeKind(state);
  if (!kind || !state.seed) return null;
  const placeName = state.seed.location.name;
  return (
    <FloatingStack>
      {/* Distinct keys: the failed notice is an `alert` that must MOUNT as a
          new element to be announced, not turn into one when retries run out. */}
      {kind === "failed" ? (
        <PlaceLoadNotice
          key="failed"
          placeName={placeName}
          showingSaved={!!state.view}
          busy={state.fetching}
          onRetry={retry}
        />
      ) : (
        <PlaceLoadNotice
          key="slow"
          slow
          placeName={placeName}
          showingSaved={false}
          busy={state.trying}
          onRetry={retry}
        />
      )}
    </FloatingStack>
  );
}
