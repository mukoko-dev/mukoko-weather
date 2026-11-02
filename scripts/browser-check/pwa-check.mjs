// Real-browser check of the PWA shell, the service worker, in-place place
// switching and a forecast that does not arrive (issue #414).
//
//   npm run build && npx next start -p 3100
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/pwa-check.mjs
//
// Read-only: only GETs to the public weather API are proxied; writes are
// refused, so nothing is created in production. Takes about 1.5 minutes.
import {
  BASE,
  PHONE,
  SHOTS,
  bodyText,
  chromium,
  classifyOffline,
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
  await proxyApi(context, {
    onCall: (method, pathname) => apiCalls.push(`${method} ${pathname}`),
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) =>
    pageErrors.push(`pageerror: ${error.message.slice(0, 160)}`),
  );
  let documentLoads = 0;
  page.on("load", () => {
    documentLoads += 1;
  });

  // 1. Cold visit to / with no cookie: Harare, no chooser.
  const started = Date.now();
  const response = await page.goto(`${BASE}/`, {
    waitUntil: "domcontentloaded",
  });
  note(
    "GET / answers 200",
    response.status() === 200,
    `status ${response.status()}, DOMContentLoaded ${Date.now() - started} ms`,
  );
  await page.waitForTimeout(4000);
  const home = await page.evaluate(() => document.body.innerText);
  note(
    "Home shows Harare, not a city chooser",
    /Harare/i.test(home) &&
      !/Use my current location[\s\S]*Browse all locations/i.test(home),
  );
  note(
    "A temperature is painted (live or stored data reached the page)",
    /\d+°/.test(home),
    (home.match(/\d+°/) ?? [""])[0],
  );

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
  note(
    "Service worker registers and activates",
    worker.supported && worker.ready && worker.active,
    JSON.stringify(worker),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  note(
    "Page is controlled by the service worker after a reload",
    await page.evaluate(() => !!navigator.serviceWorker.controller),
  );
  const cacheNames = await page.evaluate(async () => await caches.keys());
  note(
    "Caches exist (precache, pages, static)",
    cacheNames.length > 0,
    cacheNames.join(", ").slice(0, 200),
  );

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
    note(
      "URL changes to /nairobi-ke",
      page.url().endsWith("/nairobi-ke"),
      page.url(),
    );
    note(
      "Switching places does not reload the document",
      markerAfter === marker && documentLoads === loadsBefore,
      `marker kept=${markerAfter === marker}, document loads +${documentLoads - loadsBefore}`,
    );
    note("Nairobi is shown", /Nairobi/i.test(text));
    note(
      "Switching fetched only a few API calls",
      apiCalls.length - callsBefore <= 20,
      `${apiCalls.length - callsBefore} calls`,
    );

    await page.goBack();
    await page.waitForTimeout(1500);
    note(
      "Back returns to /harare without a reload",
      page.url().endsWith("/harare") &&
        (await page.evaluate(() => window.__marker)) === marker,
      page.url(),
    );
    await page.goForward();
    await page.waitForTimeout(1500);
    note(
      "Forward returns to /nairobi-ke without a reload",
      page.url().endsWith("/nairobi-ke") &&
        (await page.evaluate(() => window.__marker)) === marker,
      page.url(),
    );
  }

  // 4. Offline relaunch: the app opens from the service worker, not a browser error.
  // A page is stored only when the server sets no cookie, and the last place
  // changed since step 3 (the first visit rewrites the lastLocation cookie), so
  // it takes two visits to /harare for the second one to be stored.
  for (let visit = 0; visit < 2; visit += 1) {
    await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
  }
  await context.setOffline(true);
  let offlineKind = "navigation failed";
  let offlineDetail = "";
  try {
    const offline = await page.goto(`${BASE}/harare`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForTimeout(2500);
    const text = await bodyText(page);
    offlineKind =
      offline?.status() === 200
        ? classifyOffline(text)
        : `status ${offline?.status()}`;
    offlineDetail = `${offlineKind}; text: ${text.slice(0, 200)}`;
    await page.screenshot({ path: `${SHOTS}/offline.png` });
  } catch (error) {
    offlineDetail = `navigation failed: ${error.message.split("\n")[0]}`;
  }
  note(
    "Offline reload of a visited place opens the app (its place and temperature, not a fallback)",
    offlineKind === "APP (place + temperature)",
    offlineDetail,
  );

  // 4b. A place that was never stored: the offline page itself must start (its
  // scripts are stored by the worker), not the root error boundary.
  const missing = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("/_next/"))
      missing.push(request.url().replace(BASE, "").slice(0, 80));
  });
  await page
    .goto(`${BASE}/lagos-ng`, { waitUntil: "domcontentloaded", timeout: 15000 })
    .catch(() => null);
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
  const second = await browser.newContext({
    viewport: PHONE,
    serviceWorkers: "block",
    locale: "en-ZW",
  });
  let failing = true;
  const weatherSeen = [];
  await proxyApi(second, {
    failWeather: () => failing,
    onCall: (method, pathname) => {
      if (pathname === "/v1/weather")
        weatherSeen.push({ at: Date.now(), failing });
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
    !/Still trying/.test(quiet) &&
      (await slow.getByRole("button", { name: /try again/i }).count()) === 0,
    "t=6.5 s",
  );

  // The 8 s clock starts when the forecast is first asked for (after the page
  // hydrates), so wait for the line up to a ceiling instead of a fixed instant.
  const line = slow
    .getByRole("status")
    .filter({ hasText: "Still trying to reach the weather service" });
  const button = slow.getByRole("button", { name: /try again/i });
  await line.waitFor({ state: "visible", timeout: 12_000 });
  const lineAt = (Date.now() - t0) / 1000;
  await slow.screenshot({ path: `${SHOTS}/banner-line.png` });
  note(
    "After 8 s one calm line says it is still trying (a polite status region)",
    lineAt >= 7.5 &&
      lineAt <= 14 &&
      (await line.count()) === 1 &&
      (await line.getAttribute("aria-live")) === "polite",
    `t=${lineAt.toFixed(1)} s`,
  );
  note('"Try again" is offered at the same time', (await button.count()) === 1);
  note(
    "The skeleton is still there under it",
    (await slow.locator('[role="status"][aria-busy="true"]').count()) === 1,
  );
  const geometryAfter = await skeletonGeometry(slow);
  note(
    "Nothing moves when the line appears (skeleton boxes and page height unchanged)",
    JSON.stringify(geometryBefore) === JSON.stringify(geometryAfter),
    `${JSON.stringify(geometryBefore)} -> ${JSON.stringify(geometryAfter)}`,
  );
  const failuresByLine = weatherSeen.filter((c) => c.failing).length;
  note(
    "Failing forecast is retried with back-off, not hammered",
    failuresByLine >= 2 && failuresByLine <= 6,
    `${failuresByLine} requests in ~${lineAt.toFixed(0)} s`,
  );

  // The retries run out (about 22 s): the existing "Couldn't load" state.
  const spentNotice = slow.getByText(/Couldn't load the weather for Lagos/);
  await spentNotice.waitFor({ state: "visible", timeout: 30_000 });
  const spentAt = (Date.now() - t0) / 1000;
  const spent = await bodyText(slow);
  await slow.screenshot({ path: `${SHOTS}/banner-failed.png` });
  note(
    'When the retries are spent the existing "Couldn\'t load" notice replaces the line',
    spentAt >= 20 &&
      spentAt <= 32 &&
      !/Still trying/.test(spent) &&
      (await button.count()) === 1,
    `t=${spentAt.toFixed(1)} s`,
  );

  // "Try again" reads the forecast again now, and the page recovers.
  failing = false;
  const callsBeforeRetry = weatherSeen.length;
  await button.click();
  await slow.waitForTimeout(1500);
  note(
    "Try again makes a fresh request at once",
    weatherSeen.length > callsBeforeRetry,
    `${weatherSeen.length - callsBeforeRetry} request(s) within 1.5 s`,
  );
  await slow.waitForTimeout(4500);
  const recovered = await bodyText(slow);
  await slow.screenshot({ path: `${SHOTS}/banner-cleared.png` });
  note(
    "The notice clears and the forecast shows once the forecast works",
    (await button.count()) === 0 &&
      !/Couldn't load|Still trying/.test(recovered) &&
      /\d+°/.test(recovered),
    recovered.slice(0, 100),
  );

  await second.close();

  // The home page's location ask and the weather notice are both floating
  // cards: with the forecast failing they must stack, not lie on top of each
  // other. A fresh browser, so no stored copy answers instead of the skeleton.
  const third = await browser.newContext({
    viewport: PHONE,
    serviceWorkers: "block",
    locale: "en-ZW",
  });
  await proxyApi(third, { failWeather: () => true });
  await third.route(/open-meteo\.com/, (route) => route.abort("failed"));
  const homePage = await third.newPage();
  await homePage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const locationAsk = homePage.getByLabel("Use your location");
  const stackedLine = homePage
    .getByRole("status")
    .filter({ hasText: "Still trying to reach the weather service" });
  await stackedLine
    .waitFor({ state: "visible", timeout: 14_000 })
    .catch(() => {});
  const askBox = (await locationAsk.count())
    ? await locationAsk.boundingBox()
    : null;
  const lineBox = (await stackedLine.count())
    ? await stackedLine.boundingBox()
    : null;
  await homePage.screenshot({ path: `${SHOTS}/home-stacked.png` });
  const overlap =
    askBox && lineBox
      ? !(
          askBox.y + askBox.height <= lineBox.y + 0.5 ||
          lineBox.y + lineBox.height <= askBox.y + 0.5
        )
      : null;
  note(
    'On the home page the location ask and the "still trying" line stack, with no overlap',
    !!askBox && !!lineBox && overlap === false,
    askBox && lineBox
      ? `ask y=${Math.round(askBox.y)} h=${Math.round(askBox.height)}, line y=${Math.round(lineBox.y)} h=${Math.round(lineBox.height)}`
      : `ask: ${!!askBox}, line: ${!!lineBox}`,
  );
  await third.close();

  note(
    "No uncaught page errors",
    pageErrors.length === 0,
    pageErrors.slice(0, 3).join(" | "),
  );

  await browser.close();
  finish();
});
