// Swiping to a saved place: one that was warmed while the visitor read the
// first, against one that was not (Save-Data on, so nothing is warmed).
//
//   BASE=http://localhost:3100 node scripts/browser-check/swipe-warm.mjs
//
// What only a browser can show: that a real touch swipe (not a unit test's
// function call) goes to the next saved place, and how long the new place takes
// to appear when the Worker answers slowly (every /v1/weather answer is held
// back 800 ms). Warmed, the place paints from memory and asks for nothing;
// cold, it waits for the forecast.
import {
  API,
  BASE,
  PHONE,
  chromium,
  proxyApi,
  reporter,
  run,
} from "./harness.mjs";

const { note, finish } = reporter();

const DELAY_MS = 800;
const PLACES = ["harare", "bulawayo", "mutare"];
const HEADING = "#current-conditions-heading";

/** Open /harare as a phone with three saved places, optionally with Save-Data on. */
async function open(browser, { saveData }) {
  const context = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(
    ({ places, saveData }) => {
      try {
        localStorage.setItem(
          "mukoko-weather-prefs",
          JSON.stringify({
            state: {
              savedLocations: places,
              selectedLocation: places[0],
              hasOnboarded: true,
            },
            version: 0,
          }),
        );
      } catch {
        /* storage blocked */
      }
      if (saveData) {
        Object.defineProperty(navigator, "connection", {
          configurable: true,
          get: () => ({ saveData: true }),
        });
      }
    },
    { places: PLACES, saveData },
  );
  await proxyApi(context, { delayWeather: DELAY_MS });
  const page = await context.newPage();
  // A place's forecast is `/v1/weather?lat=&lon=`; the comparison call the
  // dashboard makes later adds `models=` and is not what a switch waits for.
  const weatherCalls = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(`${API}/v1/weather`) && !url.includes("models=")) {
      weatherCalls.push(Date.now());
    }
  });
  // A first visit to a page that does not switch places lets the app move the
  // saved places from localStorage into its database before anything else
  // writes a preference (a place page does, and would win that race).
  await page.goto(`${BASE}/about`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.textContent === "Harare",
    HEADING,
    { timeout: 30000 },
  );
  return { context, page, weatherCalls };
}

/**
 * A real touch swipe to the left across the hero (no scroller, no
 * [data-no-swipe]). Returns when the finger lifted: that is when the switch starts.
 */
async function swipeLeft(context, page) {
  const cdp = await context.newCDPSession(page);
  const y = 260;
  const from = 330;
  const to = 70;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from, y }],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from + ((to - from) * i) / 8, y: y + i }],
    });
  }
  const lifted = Date.now();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  return lifted;
}

/** Swipe, then how long from the finger lifting until the heading names the next place, and how many forecast requests it cost. */
async function swipeAndTime(context, page, weatherCalls, nextName) {
  const before = weatherCalls.length;
  const started = await swipeLeft(context, page);
  await page.waitForFunction(
    ({ sel, name }) => document.querySelector(sel)?.textContent === name,
    { sel: HEADING, name: nextName },
    { timeout: 10000, polling: 16 },
  );
  return {
    ms: Date.now() - started,
    requests: weatherCalls.length - before,
  };
}

run(async () => {
  const browser = await chromium.launch();

  // Warmed: read the first place long enough for the idle moment and the warm
  // requests (two places, one at a time, each held 800 ms) to finish.
  const warm = await open(browser, { saveData: false });
  await warm.page.waitForTimeout(6000);
  const warmed = await swipeAndTime(
    warm.context,
    warm.page,
    warm.weatherCalls,
    "Bulawayo",
  );
  note(
    "warmed: a touch swipe shows the next saved place at once",
    warmed.ms < DELAY_MS / 2,
    `${warmed.ms} ms`,
  );
  note(
    "warmed: the swipe itself asks the Worker for nothing",
    warmed.requests === 0,
    `${warmed.requests} request(s)`,
  );
  await warm.context.close();

  // Cold: Save-Data on, so nothing is warmed; the swipe waits for the forecast.
  const cold = await open(browser, { saveData: true });
  await cold.page.waitForTimeout(6000);
  const warmedByMistake = cold.weatherCalls.length;
  note(
    "cold: with Save-Data on, nothing but the place on screen was requested",
    warmedByMistake === 1,
    `${warmedByMistake} request(s) before the swipe`,
  );
  const coldSwipe = await swipeAndTime(
    cold.context,
    cold.page,
    cold.weatherCalls,
    "Bulawayo",
  );
  note(
    "cold: the same swipe waits for the held-back forecast",
    coldSwipe.ms >= DELAY_MS - 100 && coldSwipe.requests >= 1,
    `${coldSwipe.ms} ms, ${coldSwipe.requests} request(s)`,
  );
  await cold.context.close();

  await browser.close();
  finish();
});
