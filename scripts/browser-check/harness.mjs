// Shared helpers for the real-browser checks in this folder (issue #414).
//
// Playwright is NOT a dependency of this repo: run these where it is installed
// (or point NODE_PATH at its node_modules). Everything here is read-only: the
// public weather API is read through the test browser, every write is refused,
// and nothing is created in production.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");

/** The server under test: `npm run build && npx next start -p 3100`. */
export const BASE = process.env.BASE ?? "http://localhost:3100";
/** The public weather API the app reads. */
export const API = "https://weather-api.mukoko.com";
/** Where screenshots go. */
export const SHOTS = process.env.SHOTS ?? ".";

export const PHONE = { width: 390, height: 844 };

/** Print PASS/FAIL lines and a summary; `finish()` sets the exit code. */
export function reporter() {
  const results = [];
  const note = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`,
    );
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} checks passed`,
    );
    process.exit(failed.length ? 1 : 0);
  };
  return { note, finish };
}

/** Run `main`, turning a crash of the harness itself into exit code 2. */
export function run(main) {
  main().catch((error) => {
    console.error("HARNESS ERROR", error);
    process.exit(2);
  });
}

/**
 * Let the page read the public weather API from localhost: GETs are fetched as
 * the real app origin (the API's CORS list does not include localhost) and
 * handed back with a permissive header; every other method is refused.
 *
 * `failWeather()` makes `/v1/weather` answer 503 while it returns true;
 * `onCall(method, pathname)` sees every request.
 */
export async function proxyApi(
  context,
  { failWeather = () => false, onCall = () => {} } = {},
) {
  await context.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    onCall(request.method(), url.pathname);
    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": BASE,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
    }
    if (request.method() !== "GET") return route.abort("blockedbyclient");
    if (url.pathname === "/v1/weather" && failWeather()) {
      return route.fulfill({
        status: 503,
        headers: {
          "access-control-allow-origin": BASE,
          "access-control-expose-headers": "Retry-After",
          "retry-after": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ error: "unavailable" }),
      });
    }
    try {
      const response = await route.fetch({
        headers: { ...request.headers(), origin: "https://weather.mukoko.com" },
      });
      return route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": BASE,
          "access-control-expose-headers": "*",
        },
      });
    } catch {
      return route.abort("failed");
    }
  });
}

/** Install the service worker and let it take control of the page (visit, wait, reload). */
export async function installServiceWorker(page, path = "/") {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
}

/** The page's visible text on one line. */
export const bodyText = async (page) =>
  (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");

/** What the offline probe saw: the offline page, the error boundary, or the app. */
export function classifyOffline(text) {
  if (/Something went wrong/.test(text)) return "ERROR BOUNDARY";
  if (/You're offline/.test(text)) return "OFFLINE PAGE";
  if (/Harare|Lagos/.test(text) && /\d+°/.test(text))
    return "APP (place + temperature)";
  return `OTHER: ${text.slice(0, 80)}`;
}

/**
 * The name of the first cache holding a request whose URL matches `pattern`
 * (a RegExp source), or null.
 */
export const cacheHolding = (page, pattern) =>
  page.evaluate(async (source) => {
    const matcher = new RegExp(source);
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys())
        if (matcher.test(request.url)) return name;
    }
    return null;
  }, pattern.source);
