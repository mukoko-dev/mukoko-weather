// The phase 0 acceptance checks, in a real browser (#475):
//
//  1. /about sends no JavaScript of its own: the only island on the page is the
//     shell's bottom bar, and none of the heavy libraries (three.js, MapLibre,
//     Chart.js, RxDB) is requested.
//  2. The header, the bottom bar and the places lane are PERSISTENT: a click
//     between two Astro pages swaps the page and nothing else (same document,
//     same DOM nodes, same React state, same lane scroll).
//  3. A link to a page the Next.js app still owns is a full page load.
//  4. Back and forward keep the shell and the theme, and the theme is applied
//     before the first paint.
//
//   node scripts/check-shell.mjs        (serves dist/client itself)
import { startServer } from "./serve-dist.mjs";
import { launch, devices } from "./browser.mjs";

const HEAVY = /three|maplibre|chart(?:\.js|js)|rxdb|dexie|leaflet|serwist/i;
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

try {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    colorScheme: "dark",
  });
  const page = await context.newPage();
  const requests = [];
  const problems = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  // On the real origin the Next.js app serves these (icons, the manifest and
  // its own pages); this server has only the Astro build, so they are 404 here.
  const NEXT_OWNED = /^\/(manifest\.json|favicon|apple-touch-icon|explore)/;
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && !NEXT_OWNED.test(path))
      problems.push(`${r.status()} ${path}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) {
      problems.push(`console: ${m.text()}`);
    }
  });

  // 1. /about on its own
  await page.goto(`${base}/about`, { waitUntil: "networkidle" });
  const islands = await page.$$eval("astro-island", (els) =>
    els.map(
      (el) =>
        el.getAttribute("component-export") +
        ":" +
        el.getAttribute("component-url"),
    ),
  );
  check(
    islands.length === 1 && /BottomBar/.test(islands[0]),
    "the only island on /about is the bottom bar",
    islands.join(", "),
  );
  const scripts = requests.filter((p) => p.endsWith(".js"));
  check(
    !scripts.some((p) => HEAVY.test(p)),
    "no three.js, MapLibre, Chart.js, RxDB or Serwist is requested",
    scripts.join(", "),
  );
  check(
    (await page.locator("main h1").textContent())?.includes(
      "About mukoko weather",
    ) === true,
    "the page text is in the HTML",
  );
  check(
    (await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    )) === "dark",
    "the theme is applied from the device (dark)",
  );
  await page.waitForSelector("astro-island:not([ssr])", { timeout: 10000 });
  check(true, "the bottom bar island hydrates");

  // 2. persistence across a client-side navigation
  await page.goto(`${base}/shell-preview`, { waitUntil: "networkidle" });
  await page.waitForSelector("astro-island:not([ssr])");
  const lane = page
    .locator('[aria-label="Saved places and suggestions"]')
    .locator("..");
  const scrollable = await lane.evaluate(
    (el) => el.scrollWidth > el.clientWidth,
  );
  check(
    scrollable,
    "the lane has more places than fit, so its scroll can be tested",
  );
  await page.evaluate(() => {
    window.__doc = "same-document";
    const lanes = document.querySelector(
      '[aria-label="Saved places and suggestions"]',
    );
    lanes.parentElement.scrollLeft = 40;
    document.querySelector("[data-slot=mzizi-bottom-nav]").__mark = "bar";
    document.querySelector("[data-site-header]").__mark = "header";
    lanes.__mark = "lane";
    window.scrollTo(0, 400);
  });
  const before = await page.evaluate(() => ({
    scrollLeft: document.querySelector(
      '[aria-label="Saved places and suggestions"]',
    ).parentElement.scrollLeft,
  }));
  check(
    await page
      .waitForFunction(() =>
        document
          .querySelector("[data-site-header]")
          ?.hasAttribute("data-scrolled"),
      )
      .then(
        () => true,
        () => false,
      ),
    "the header marks itself scrolled once the page is scrolled",
  );
  const loads = [];
  page.on("load", () => loads.push("load"));
  await page.click('[data-testid="to-about-bottom"]');
  await page.waitForURL(`${base}/about`);
  await page.waitForSelector("main h1");
  const after = await page.evaluate(() => ({
    doc: window.__doc,
    bar: document.querySelector("[data-slot=mzizi-bottom-nav]")?.__mark,
    header: document.querySelector("[data-site-header]")?.__mark,
    lane: document.querySelector('[aria-label="Saved places and suggestions"]')
      ?.__mark,
    scrollLeft: document.querySelector(
      '[aria-label="Saved places and suggestions"]',
    )?.parentElement.scrollLeft,
    theme: document.documentElement.getAttribute("data-theme"),
    heading: document.querySelector("main h1")?.textContent,
  }));
  check(
    after.doc === "same-document" && loads.length === 0,
    "a tap between Astro pages is not a page load",
  );
  check(
    after.bar === "bar",
    "the bottom bar is the same DOM node after navigation",
  );
  check(
    after.header === "header",
    "the header is the same DOM node after navigation",
  );
  check(
    after.lane === "lane",
    "the places lane is the same DOM node after navigation",
  );
  check(
    Math.abs(after.scrollLeft - before.scrollLeft) <= 1,
    "the lane keeps its scroll",
    `${before.scrollLeft} -> ${after.scrollLeft}`,
  );
  check(after.theme === "dark", "the theme survives the swap");
  check(
    await page.evaluate(
      () =>
        window.scrollY === 0 &&
        !document
          .querySelector("[data-site-header]")
          ?.hasAttribute("data-scrolled"),
    ),
    "the persisted header follows the page back to the top after the swap",
  );
  check(
    after.heading?.includes("About mukoko weather") === true,
    "the page was swapped",
  );

  // 4. back and forward
  await page.goBack();
  await page.waitForURL(`${base}/shell-preview`);
  await page.waitForSelector('main h1:has-text("Shell preview")');
  const back = await page.evaluate(() => ({
    doc: window.__doc,
    bar: document.querySelector("[data-slot=mzizi-bottom-nav]")?.__mark,
    h1: document.querySelector("main h1")?.textContent,
  }));
  check(
    back.doc === "same-document" &&
      back.bar === "bar" &&
      back.h1 === "Shell preview",
    "back keeps the document and the bar",
    JSON.stringify(back),
  );

  // 3. a page the Next.js app owns is a full load
  const navigated = page.waitForEvent("framenavigated", { timeout: 5000 });
  await page.click('[data-testid="to-next"]');
  await navigated.catch(() => null);
  await page.waitForTimeout(500);
  check(
    (await page.evaluate(() => window.__doc)) === undefined,
    "a link to a Next.js page is a full page load",
  );

  check(
    problems.length === 0,
    "no console errors or page errors",
    problems.join(" | "),
  );
  await context.close();
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nshell checks passed");
