// Offline launch: the installed app opens at `/` from what is stored, and a
// place that was never stored shows the "You're offline" page with its scripts
// available, not the root error boundary ("Something went wrong").
//
//   BASE=http://localhost:3100 node scripts/browser-check/offline-shell.mjs
//
// Five fresh browsers: two offline launches of `/` (must paint the saved place
// and its temperature) and three of `/lagos-ng` (must be the offline page).
import {
  BASE,
  PHONE,
  bodyText,
  chromium,
  classifyOffline,
  installServiceWorker,
  proxyApi,
  reporter,
  run,
} from "./harness.mjs";

const { note, finish } = reporter();

async function launchOffline(target) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: PHONE,
    locale: "en-ZW",
  });
  await proxyApi(context);
  const page = await context.newPage();
  await installServiceWorker(page);
  await context.setOffline(true);
  const failed = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("/_next/"))
      failed.push(request.url().replace(BASE, "").slice(0, 80));
  });
  await page
    .goto(BASE + target, { waitUntil: "domcontentloaded", timeout: 20000 })
    .catch(() => null);
  await page.waitForTimeout(6000);
  const kind = classifyOffline(await bodyText(page));
  await browser.close();
  return { kind, failed };
}

run(async () => {
  for (const [i, target, want] of [
    [1, "/", "APP (place + temperature)"],
    [2, "/", "APP (place + temperature)"],
    [3, "/lagos-ng", "OFFLINE PAGE"],
    [4, "/lagos-ng", "OFFLINE PAGE"],
    [5, "/lagos-ng", "OFFLINE PAGE"],
  ]) {
    const { kind, failed } = await launchOffline(target);
    note(
      `[${i}] offline launch of ${target} shows ${want}`,
      kind === want && failed.length === 0,
      `${kind}; _next requests failed: ${failed.length ? failed.join(" | ") : "none"}`,
    );
  }
  finish();
});
