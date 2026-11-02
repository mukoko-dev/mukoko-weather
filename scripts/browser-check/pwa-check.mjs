// Real-browser check of the PWA shell, the service worker, in-place place
// switching and a forecast that does not arrive (issue #414).
//
//   npm run build && npx next start -p 3100
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/pwa-check.mjs
//
// Read-only: only GETs to the public weather API are proxied; writes are
// refused, so nothing is created in production. Takes about 1.5 minutes.
import {
  API,
  BASE,
  PHONE,
  SHOTS,
  bodyText,
  chromium,
  proxyApi,
  reporter,
  run,
} from "./harness.mjs";

const { note, finish } = reporter();

/** Pixels of the skeleton's own boxes and the page, to prove nothing moves. */
const skeletonGeometry = (page) =>
  page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { top, height, width } = element.getBoundingClientRect();
      return [Math.round(top), Math.round(height), Math.round(width)];
    };
    return {
      hero: box('[data-skeleton="hero"]'),
      conditions: box('[data-skeleton="conditions"]'),
      pageHeight: document.documentElement.scrollHeight,
    };
  });

run(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: PHONE,
    serviceWorkers: "allow",
    locale: "en-ZW",
  });

  const apiCalls = [];
  await proxyApi(context, { onCall: (method, pathname) => apiCalls.push(`${method} ${pathname}`) });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message.slice(0, 160)}`));
  let documentLoads = 0;
  page.on("load", () => {
    documentLoads += 1;
  });

  // 1. Cold visit to / with no cookie: Harare, no chooser.
  const started = Date.now();
  const response = await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  note(
    "GET / answers 200",
    response.status() === 200,
    `status ${response.status()}, DOMContentLoaded ${Date.now() - started} ms`,
  );
  await page.waitForTimeout(4000);
  const home = await page.evaluate(() => document.body.innerText);
  note(
    "Home shows Harare, not a city chooser",
    /Harare/i.test(home) && !/Use my current location[\s\S]*Browse all locations/i.test(home),
  );
  note("A temperature is painted (live or stored data reached the page)", /\d+°/.test(home), (home.match(/\d+°/) ?? [""])[0]);

  // 2. The service worker installs and takes control.
  const worker = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
    ]);
    return {
      supported: true,
      ready: !!registration,
      scope: registration?.scope,
      active: !!registration?.active,
    };
  });
  note("Service worker registers and activates", worker.supported && worker.ready && worker.active, JSON.stringify(worker));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  note("Page is controlled by the service worker after a reload", await page.evaluate(() => !!navigator.serviceWorker.controller));
  const cacheNames = await page.evaluate(async () => await caches.keys());
  note("Caches exist (precache, pages, static)", cacheNames.length > 0, cacheNames.join(", ").slice(0, 200));

  // 3. In-place switching: the document must not reload.
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    window.__marker = `alive-${Math.random()}`;
  });
  const marker = await page.evaluate(() => window.__marker);
  const loadsBefore = documentLoads;
  const callsBefore = apiCalls.length;
  await page.screenshot({ path: `${SHOTS}/harare.png` });
  const dot = page.locator('a[href="/nairobi-ke"]').first();
  const hasDot = (await dot.count()) > 0;
  note("Pager offers Nairobi", hasDot);
  if (hasDot) {
    await dot.click();
    await page.waitForURL("**/nairobi-ke", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const markerAfter = await page.evaluate(() => window.__marker);
    const text = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: `${SHOTS}/nairobi.png` });
    note("URL changes to /nairobi-ke", /\/nairobi-ke$/.test(page.url()), page.url());
    note(
      "Switching places does not reload the document",
      markerAfter === marker && documentLoads === loadsBefore,
      `marker kept=${markerAfter === marker}, document loads +${documentLoads - loadsBefore}`,
    );
    note("Nairobi is shown", /Nairobi/i.test(text));
    note("Switching fetched only a few API calls", apiCalls.length - callsBefore <= 20, `${apiCalls.length - callsBefore} calls`);

    await page.goBack();
    await page.waitForTimeout(1500);
    note("Back returns to /harare without a reload", /\/harare$/.test(page.url()) && (await page.evaluate(() => window.__marker)) === marker, page.url());
    await page.goForward();
    await page.waitForTimeout(1500);
    note("Forward returns to /nairobi-ke without a reload", /\/nairobi-ke$/.test(page.url()) && (await page.evaluate(() => window.__marker)) === marker, page.url());
  }

  // 4. Offline relaunch: the app opens from the service worker, not a browser error.
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000); // let the page be stored
  await context.setOffline(true);
  let offlineOk = false;
  let offlineDetail = "";
  try {
    const offline = await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    offlineOk = !!offline && offline.status() === 200 && /Harare|offline|mukoko/i.test(text);
    offlineDetail = `status ${offline?.status()}, text: ${text.replace(/\s+/g, " ").slice(0, 260)}`;
    await page.screenshot({ path: `${SHOTS}/offline.png` });
  } catch (error) {
    offlineDetail = `navigation failed: ${error.message.split("\n")[0]}`;
  }
  note("Offline reload of a visited place opens the app", offlineOk, offlineDetail);

  // 4b. A place that was never stored: the offline page itself must start (its
  // scripts are stored by the worker), not the root error boundary.
  const missing = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("/_next/")) missing.push(request.url().replace(BASE, "").slice(0, 80));
  });
  await page.goto(`${BASE}/lagos-ng`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(5000);
  const unseen = await bodyText(page);
  note(
    "Offline launch of a never-stored place shows the offline page, not the error boundary",
    /You're offline/.test(unseen) && !/Something went wrong/.test(unseen),
    `${unseen.slice(0, 80)}; _next requests failed: ${missing.length ? missing.join(" | ") : "none"}`,
  );
  await context.setOffline(false);

  // 5. A forecast that does not arrive. A separate context with the service
  // worker blocked, so the injected failure reaches the page; Open-Meteo, the
  // app's own fallback, is refused too.
  const second = await browser.newContext({ viewport: PHONE, serviceWorkers: "block", locale: "en-ZW" });
  let failing = true;
  const weatherSeen = [];
  await proxyApi(second, {
    failWeather: () => failing,
    onCall: (method, pathname) => {
      if (pathname === "/v1/weather") weatherSeen.push({ at: Date.now(), failing });
    },
  });
  await second.route(/open-meteo\.com/, (route) => route.abort("failed"));
  const slow = await second.newPage();
  const t0 = Date.now();
  await slow.goto(`${BASE}/lagos-ng`, { waitUntil: "domcontentloaded" });

  await slow.waitForTimeout(6500 - (Date.now() - t0));
  const quiet = await bodyText(slow);
  const geometryBefore = await skeletonGeometry(slow);
  note(
    "Before 8 s the skeleton is alone: no line, no button",
    !/Still trying/.test(quiet) && (await slow.getByRole("button", { name: /try again/i }).count()) === 0,
    "t=6.5 s",
  );

  await slow.waitForTimeout(10_000 - (Date.now() - t0));
  const line = slow.getByRole("status").filter({ hasText: "Still trying to reach the weather service" });
  const button = slow.getByRole("button", { name: /try again/i });
  await slow.screenshot({ path: `${SHOTS}/banner-10s.png` });
  note("After 8 s one calm line says it is still trying (a polite status region)", (await line.count()) === 1 && (await line.getAttribute("aria-live")) === "polite", "t=10 s");
  note("\"Try again\" is offered at the same time", (await button.count()) === 1);
  note("The skeleton is still there under it", (await slow.locator('[role="status"][aria-busy="true"]').count()) === 1);
  const geometryAfter = await skeletonGeometry(slow);
  note(
    "Nothing moves when the line appears (skeleton boxes and page height unchanged)",
    JSON.stringify(geometryBefore) === JSON.stringify(geometryAfter),
    `${JSON.stringify(geometryBefore)} -> ${JSON.stringify(geometryAfter)}`,
  );
  const failuresBy10 = weatherSeen.filter((c) => c.failing).length;
  note("Failing forecast is retried with back-off, not hammered", failuresBy10 >= 2 && failuresBy10 <= 6, `${failuresBy10} requests in ~10 s`);

  // The retries run out (about 22 s): the existing "Couldn't load" state.
  await slow.waitForTimeout(26_000 - (Date.now() - t0));
  const spent = await bodyText(slow);
  await slow.screenshot({ path: `${SHOTS}/banner-26s.png` });
  note(
    "When the retries are spent the existing \"Couldn't load\" notice replaces the line",
    /Couldn't load the weather for Lagos/.test(spent) && !/Still trying/.test(spent) && (await button.count()) === 1,
    "t=26 s",
  );

  // "Try again" reads the forecast again now, and the page recovers.
  failing = false;
  const callsBeforeRetry = weatherSeen.length;
  await button.click();
  await slow.waitForTimeout(1500);
  note("Try again makes a fresh request at once", weatherSeen.length > callsBeforeRetry, `${weatherSeen.length - callsBeforeRetry} request(s) within 1.5 s`);
  await slow.waitForTimeout(4500);
  const recovered = await bodyText(slow);
  await slow.screenshot({ path: `${SHOTS}/banner-cleared.png` });
  note(
    "The notice clears and the forecast shows once the forecast works",
    (await button.count()) === 0 && !/Couldn't load|Still trying/.test(recovered) && /\d+°/.test(recovered),
    recovered.slice(0, 100),
  );
  await second.close();

  note("No uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  await browser.close();
  finish();
});
