"use client";

import critical from "@/lib/critical-css/critical.generated.json";
import { afterPaintWhenIdle } from "@/lib/weather-scenes/start-gate";

/**
 * How the stylesheet reaches `/` and the place pages (issue #551).
 *
 * The whole sheet is 213 KB (35 KB gzipped) and, linked in the head, held the
 * first paint of a phone on Slow 4G until it had arrived behind the page's
 * scripts. These two pages now ship only the rules their first screen uses,
 * inline, and fetch the sheet after the first paint:
 *
 * - `CriticalStyles` puts the subset (src/lib/critical-css, made by
 *   scripts/critical-css from the real DOM of these pages) into the head. It
 *   is a Client Component whose string exists only in the server render: the
 *   server tree would send the same text a second time in its payload, and the
 *   browser's script bundle would carry it a third time. The HTML holds it once.
 * - The whole sheet is requested by this module itself, in the browser, once the
 *   weather has painted and the browser is idle: the module runs when the
 *   page hydrates `CriticalStyles`. It arrives as a stylesheet that nothing
 *   waits for, and completes the subset (hover and focus states, what a tap opens, what a
 *   scroll brings in). It repeats the subset's rules in their original order,
 *   so once it is in, the page is exactly what the sheet alone made.
 *
 * Every other route imports the sheet in its own page and is unchanged
 * (src/app/critical-css-routes.test.ts holds the list).
 */
export function CriticalStyles() {
  return (
    // `href` + `precedence` make this a React style resource: it goes to the
    // head, and the fallback and the page asking for it is one element, not two.
    <style href="critical-css" precedence="critical-css">
      {typeof window === "undefined" ? critical.css : ""}
    </style>
  );
}

let requested = false;

function requestFullStylesheet() {
  if (requested || typeof window === "undefined") return;
  requested = true;
  // A dynamic import of a stylesheet is a stylesheet link that nothing waits for.
  void import("@/app/globals.css").catch(() => {
    // Offline and not cached: the subset is what there is. Ask again next time.
    requested = false;
  });
}

/** How often the page is looked at for its weather, and for how long. */
const WEATHER_POLL_MS = 200;
const WEATHER_MAX_WAIT_MS = 8000;

/**
 * Run `start` once the real weather is on screen (the hero without its
 * skeleton, the same mark the lab harness uses) or the page has said it has
 * none (an unknown place), then after two frames and the browser's next idle
 * moment; or `WEATHER_MAX_WAIT_MS` after the page started, for a page that
 * never gets weather (offline, nothing stored).
 */
function afterWeather(start: () => void) {
  // The weather, or the answer that a place has none (its not-found view).
  const weather = () =>
    document.querySelector(
      "[data-sky-hero]:not([data-skeleton]), #not-found-heading",
    ) !== null;
  const began = Date.now();
  const look = () => {
    if (weather() || Date.now() - began >= WEATHER_MAX_WAIT_MS)
      afterPaintWhenIdle(start);
    else setTimeout(look, WEATHER_POLL_MS);
  };
  look();
}

// When the browser runs this module (the page's scripts load it) it waits for
// the first screen: the sheet applied earlier would restyle a page that is being
// hydrated, and a phone pays for that in the hydration, and the sheet's 35 KB
// share the link with the scripts that bring the weather. Measured on the lab
// phone (Slow 4G, 4x CPU): asked for as soon as the module ran, warm real
// weather came 140 ms later; asked for after the weather, 90 ms earlier, and
// cold real weather 650 ms earlier.
if (typeof window !== "undefined") afterWeather(requestFullStylesheet);
