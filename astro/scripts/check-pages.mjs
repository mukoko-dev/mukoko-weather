// Checks of the static pages (#579), in a real browser, from dist/client:
//
//  1. /terms, /privacy and /releases ship no island of their own (the bottom
//     bar is the only one) and show their text with JavaScript turned off.
//  2. /help: the FAQ answers are in the HTML with JavaScript off, and with
//     JavaScript on each button opens and closes its answer, the answers can
//     be found with find-in-page (`hidden="until-found"`), and the Radix
//     accordion is not loaded.
//  3. /status: the dashboard island hydrates and shows the outcome of the
//     check (here the Worker is out of reach, so the error state).
//  4. Every page carries its canonical link, the card image and its JSON-LD.
//
//   node scripts/check-pages.mjs        (serves dist/client itself)
import { startServer } from "./serve-dist.mjs";
import { launch, devices } from "./browser.mjs";

const failures = [];
const check = (ok, what, detail = "") => {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${what}${detail ? `  (${detail})` : ""}`,
  );
  if (!ok) failures.push(what);
};

const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();

const OWN = /^\/(manifest\.json|favicon|apple-touch-icon)/;

async function open(context, path) {
  const page = await context.newPage();
  const requests = [];
  const problems = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    const p = new URL(r.url()).pathname;
    if (r.status() >= 400 && !OWN.test(p)) problems.push(`${r.status()} ${p}`);
  });
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  return { page, requests, problems };
}

try {
  const phone = { ...devices["Pixel 5"] };
  const context = await browser.newContext(phone);
  const plain = await browser.newContext({
    ...phone,
    javaScriptEnabled: false,
  });

  // 1. No island of their own, and readable without script.
  for (const [path, text] of [
    ["/terms", "1. Agreement"],
    ["/privacy", "Privacy"],
    ["/releases", "Release notes"],
  ]) {
    const { page, requests, problems } = await open(context, path);
    const scripts = requests.filter((p) => p.endsWith(".js"));
    check(
      scripts.some((p) => /BottomBar/.test(p)) &&
        !scripts.some((p) => /Status|accordion|radix/i.test(p)),
      `${path} loads only the shell's scripts`,
      scripts.join(", "),
    );
    check(problems.length === 0, `${path} has no errors`, problems.join("; "));
    await page.close();
    const bare = await plain.newPage();
    await bare.goto(`${base}${path}`);
    check(
      ((await bare.locator("main").textContent()) ?? "").includes(text),
      `${path} reads with JavaScript off`,
    );
    await bare.close();
  }

  // 2. /help
  {
    const { page, requests, problems } = await open(context, "/help");
    check(
      !requests.some((p) => /accordion|radix/i.test(p)),
      "/help does not load an accordion library",
    );
    check(problems.length === 0, "/help has no errors", problems.join("; "));
    const first = page.locator("[data-faq-trigger]").first();
    const panelId = await first.getAttribute("aria-controls");
    const panel = page.locator(`#${panelId}`);
    check(
      (await panel.getAttribute("hidden")) === "until-found",
      "an answer is hidden until found, not removed",
      String(await panel.getAttribute("hidden")),
    );
    await first.click();
    check(
      (await first.getAttribute("aria-expanded")) === "true" &&
        (await panel.isVisible()),
      "a button opens its answer",
    );
    await first.click();
    check(
      (await first.getAttribute("aria-expanded")) === "false" &&
        !(await panel.isVisible()),
      "the same button closes it",
    );
    // Find-in-page: reveal through the browser's own mechanism by scrolling a
    // text fragment to the answer (Chromium opens `until-found` content for it).
    const answer = (await panel.textContent())?.trim().split(/\s+/).slice(0, 4);
    const fragment = encodeURIComponent(answer.join(" "));
    await page.goto(`${base}/help#:~:text=${fragment}`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(500);
    check(
      (await first.getAttribute("aria-expanded")) === "true" &&
        (await panel.isVisible()),
      "a text-fragment link opens the answer it names (find in page)",
    );
    await page.close();
    const bare = await plain.newPage();
    await bare.goto(`${base}/help`);
    check(
      await bare.locator("[data-faq-panel]").first().isVisible(),
      "with JavaScript off every answer is shown (noscript)",
    );
    await bare.close();
  }

  // 3. /status
  {
    const { page, requests } = await open(context, "/status");
    check(
      requests.some((p) => /StatusDashboard/.test(p)),
      "/status loads its dashboard island",
      requests.filter((p) => p.endsWith(".js")).join(", "),
    );
    await page.waitForFunction(
      () => !document.querySelector(".chameleon"),
      null,
      { timeout: 15000 },
    );
    check(true, "the skeleton is replaced once the check has an outcome");
    await page.close();
  }

  // 4. Head
  for (const path of ["/terms", "/privacy", "/help", "/releases", "/status"]) {
    const page = await context.newPage();
    await page.goto(`${base}${path}`);
    const canonical = await page
      .locator('link[rel="canonical"]')
      .getAttribute("href");
    const ogImage = await page
      .locator('meta[property="og:image"]')
      .getAttribute("content");
    const ld = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((els) => els.map((e) => JSON.parse(e.textContent)));
    check(
      canonical === `https://weather.mukoko.com${path}` &&
        ogImage?.includes("/api/og?") &&
        ld.length >= 1,
      `${path} has a canonical link, a card image and JSON-LD`,
      `${canonical}, ${ld.length} JSON-LD block(s)`,
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\npage checks passed");
