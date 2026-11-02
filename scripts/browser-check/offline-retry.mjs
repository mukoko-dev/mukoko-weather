// The /offline page's scripts get a second chance. The service worker's install
// pass is made to fail (the offline route's own chunk is refused), then one
// ordinary online navigation, a minute later, stores it, and the page starts.
//
//   BASE=http://localhost:3100 node scripts/browser-check/offline-retry.mjs
//
// Takes about 90 s: an unfinished pass is repeated at most once a minute.
import {
  BASE,
  PHONE,
  bodyText,
  cacheHolding,
  chromium,
  classifyOffline,
  installServiceWorker,
  proxyApi,
  reporter,
  run,
} from "./harness.mjs";

const { note, finish } = reporter();
// The offline route's own chunk: the build's hash changes, its place does not.
const OFFLINE_ONLY = /\/_next\/static\/chunks\/app\/offline\/page-/;

run(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: PHONE, locale: "en-ZW" });
  await proxyApi(context);

  // Refuse the chunk only the offline page uses (the worker reads the build's
  // names from the page's own HTML; nothing here knows a hash).
  let blocking = true;
  const refused = [];
  await context.route(OFFLINE_ONLY, (route) => {
    if (!blocking) return route.continue();
    refused.push(route.request().url());
    return route.abort("failed");
  });

  const page = await context.newPage();
  await installServiceWorker(page);
  const stored = await cacheHolding(page, /app\/offline\/page-/);
  note(
    "install with the offline route's chunk refused does not store it (and does not fail)",
    refused.length >= 1 && stored === null,
    `${refused.length} request(s) refused; chunk stored: ${stored ?? "no"}`,
  );

  blocking = false;
  await page.waitForTimeout(62_000);
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const route = await cacheHolding(page, /app\/offline\/page-/);
  note("one online navigation stores it", !!route, route ?? "no");

  // What is stored must be the script, not a page stored under its URL.
  const types = await page.evaluate(async () => {
    const cache = await caches.open("static-assets");
    const out = [];
    for (const request of await cache.keys()) {
      if (/app\/offline\/page-/.test(request.url)) {
        out.push((await cache.match(request)).headers.get("content-type"));
      }
    }
    return out;
  });
  note(
    "the stored file is a script (never HTML under a script's URL)",
    types.length === 1 && types.every((type) => /javascript/.test(type ?? "")),
    types.join(", "),
  );

  await context.setOffline(true);
  await page.goto(`${BASE}/lagos-ng`, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(6000);
  const kind = classifyOffline(await bodyText(page));
  note("offline /lagos-ng then shows the offline page", kind === "OFFLINE PAGE", kind);

  await browser.close();
  finish();
});
