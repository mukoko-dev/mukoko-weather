// Does the first screen look the same with only the critical subset, and the
// same as before the subset existed? (issue #551)
//
// `/` and the place page ship the rules their first screen uses inline and
// fetch the rest of the stylesheet after the first paint (src/lib/critical-css,
// scripts/critical-css). Three checks answer whether that changed anything a
// person sees. They run against a production build served on this machine
// (`npm run build && npx next start -p 3151`), with the network answered by the
// script (`mockNetwork`: one forecast, no provider is asked), reduced motion on
// and the page's clock fixed, so two renders of the same page are the same
// pixels.
//
//   BASE=http://localhost:3151 node scripts/browser-check/critical-css.mjs coverage
//     Loads every scenario twice, once with the rest of the stylesheet held back
//     and once with it, and compares the computed style of EVERY element. A
//     rule the first screen uses that is not in the subset shows up as an
//     element whose style differs. Exit 1 if any does. (This is the browser
//     check behind the subset; src/lib/critical-css/critical-css.test.ts is the
//     one CI runs.)
//
//   BASE=http://localhost:3151 node scripts/browser-check/critical-css.mjs offline
//     The installed app, offline: `/` opened with no network from the worker's
//     stored page must be styled as it is online, which means the rest of the
//     stylesheet came from the worker's precache and the inline subset from the
//     stored page. Compares the computed style of every element, online and
//     offline, light and dark.
//
//   BASE=... SHOTS=/tmp/shots LABEL=before node scripts/browser-check/critical-css.mjs shoot
//   BASE=... SHOTS=/tmp/shots LABEL=after  node scripts/browser-check/critical-css.mjs shoot
//   SHOTS=/tmp/shots node scripts/browser-check/critical-css.mjs diff before after
//     Screenshots of every scenario at 393x852 (the viewport and the whole
//     page), taken on two builds (staging, then the change), then compared
//     pixel by pixel. `HOLD_REST=1` takes the shots with the rest of the
//     stylesheet held back, so the first paint alone is compared.
//
// Scenarios: `/`, a place page (`/harare--ksy4dd1`, Harare) and a place that does not exist,
// each light and dark (the phone's setting), each as a first visit (nothing
// stored) and a return visit (the stored place and forecast are on the device).
// Other settings: WIDTH and HEIGHT (default 393x852), CHROME_PATH.
import { createRequire } from "node:module";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BASE } from "./harness.mjs";
import { mockNetwork } from "./memory-harness.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const WIDTH = Number(process.env.WIDTH ?? 393);
const HEIGHT = Number(process.env.HEIGHT ?? 852);
const SHOTS = process.env.SHOTS ?? join(tmpdir(), "critical-css-shots");
const LABEL = process.env.LABEL ?? "run";
const HOLD_REST = Boolean(process.env.HOLD_REST);
// A control for `coverage`: take the inline subset out of the HTML as well, so
// the page with the rest held back has no stylesheet of ours at all. The check
// must then fail; if it does not, it is not looking.
const STRIP_CRITICAL = Boolean(process.env.STRIP_CRITICAL);
// Run only the scenarios whose name contains this text.
const ONLY = process.env.ONLY ?? "";
// ROUTES="/about,/help" runs other pages (which must look as they did).
const ROUTES = (
  process.env.ROUTES ?? "/,/harare--ksy4dd1,/no-such-place-zz"
).split(",");
const SCHEMES = ["light", "dark"];
const VISITS = ["first", "return"];
// One fixed moment for the page: the hero's sky, the "updated" line and the
// forecast's current hour all follow the clock.
const NOW = new Date();
NOW.setUTCHours(11, 0, 0, 0);

const name = (route, scheme, visit) =>
  `${route === "/" ? "home" : route.slice(1).replaceAll("/", "_")}-${scheme}-${visit}`;

/** The stylesheets the page's HTML links: the ones that block its first paint. */
async function linkedSheets(route) {
  const html = await fetch(BASE + route, { redirect: "follow" }).then((r) =>
    r.text(),
  );
  return new Set(
    [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]
      .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
      .filter(Boolean),
  );
}

async function loadScenario(browser, route, scheme, visit, holdRest) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    viewport: { width: WIDTH, height: HEIGHT },
    colorScheme: scheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    locale: "en-ZW",
    timezoneId: "Africa/Harare",
  });
  await context.clock.install({ time: NOW });
  await mockNetwork(context);
  if (holdRest && STRIP_CRITICAL)
    await context.route(
      (url) =>
        url.origin === new URL(BASE).origin &&
        !url.pathname.startsWith("/_next/"),
      async (route) => {
        if (route.request().resourceType() !== "document")
          return route.fallback();
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /<style data-precedence="critical-css"[\s\S]*?<\/style>/,
          "",
        );
        return route.fulfill({ response, body });
      },
    );
  if (holdRest) {
    // Hold back every stylesheet the HTML does not link: the rest of the sheet
    // is the one the page asks for from script, after the first paint.
    const linked = await linkedSheets(route);
    await context.route(/\/_next\/static\/css\/.*\.css/, (r) => {
      const path = new URL(r.request().url()).pathname;
      return linked.has(path) ? r.fallback() : r.abort("blockedbyclient");
    });
  }
  const open = async () => {
    const page = await context.newPage();
    await page.goto(BASE + route, { waitUntil: "load" });
    if (route === "/" || route.startsWith("/harare"))
      await page
        .waitForSelector("[data-sky-hero]:not([data-skeleton])", {
          timeout: 30000,
        })
        .catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(4000);
    return page;
  };
  let page = await open();
  if (visit === "return") {
    await page.close();
    page = await open();
  }
  return { context, page };
}

/** Every element's computed style, as one string each. */
const READ_STYLES = () =>
  [...document.querySelectorAll("*")].map((el) => {
    const cs = getComputedStyle(el);
    const props = [];
    for (const p of cs) props.push(`${p}:${cs.getPropertyValue(p)}`);
    // The order custom properties are listed in follows the stylesheet's.
    props.sort();
    const cls = typeof el.className === "string" ? el.className : "";
    return [`${el.localName}.${cls.slice(0, 60)}`, props.join(";")];
  });

function launch() {
  return chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      `--unsafely-treat-insecure-origin-as-secure=${new URL(BASE).origin}`,
    ],
  });
}

/**
 * Pair the entries of two lists of labels in order (the longest common
 * subsequence), as `[indexInA, indexInB]`. Quadratic, which a page of a few
 * thousand elements can afford.
 */
function align(a, b) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

async function coverage() {
  const browser = await launch();
  let failures = 0;
  try {
    for (const route of ROUTES)
      for (const scheme of SCHEMES)
        for (const visit of VISITS) {
          const id = name(route, scheme, visit);
          if (ONLY && !id.includes(ONLY)) continue;
          const read = async (holdRest) => {
            const { context, page } = await loadScenario(
              browser,
              route,
              scheme,
              visit,
              holdRest,
            );
            const styles = await page.evaluate(READ_STYLES);
            await context.close();
            return styles;
          };
          const held = await read(true);
          const full = await read(false);
          // The page is not frozen: a skeleton, a late card or the sky can be
          // there in one load and not yet in the other. Pair the elements by
          // order and label (a plain diff of the two lists) and compare the
          // pairs; the ones that have no partner are reported, not compared.
          const pairs = align(
            held.map(([label]) => label),
            full.map(([label]) => label),
          );
          const different = [];
          for (const [i, j] of pairs) {
            const a = held[i][1];
            const b = full[j][1];
            if (a === b) continue;
            const A = new Map(a.split(";").map((x) => x.split(/:(.*)/s)));
            const B = new Map(b.split(";").map((x) => x.split(/:(.*)/s)));
            const props = [...new Set([...A.keys(), ...B.keys()])].filter(
              (k) => A.get(k) !== B.get(k),
            );
            different.push(
              `${held[i][0]} ${props
                .slice(0, 4)
                .map((p) => `${p}: ${A.get(p)} -> ${B.get(p)}`)
                .join("; ")}`,
            );
          }
          const unpaired = held.length - pairs.length;
          const unpairedFull = full.length - pairs.length;
          console.log(
            `${different.length ? "FAIL" : "PASS"}  ${id}: ${pairs.length} elements compared, ${different.length} differ` +
              (unpaired || unpairedFull
                ? ` (${unpaired} only with the rest held back, ${unpairedFull} only with it)`
                : ""),
          );
          for (const d of different.slice(0, 8)) console.log(`        ${d}`);
          const pairedHeld = new Set(pairs.map(([i]) => i));
          const pairedFull = new Set(pairs.map(([, j]) => j));
          for (const [k, [label]] of held.entries())
            if (!pairedHeld.has(k))
              console.log(`        only held back: ${label}`);
          for (const [k, [label]] of full.entries())
            if (!pairedFull.has(k)) console.log(`        only full: ${label}`);
          if (different.length) failures++;
        }
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} scenarios differ` : "\nno differences");
  process.exit(failures ? 1 : 0);
}

async function offline() {
  const browser = await launch();
  let failures = 0;
  try {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({
        ...devices["Pixel 5"],
        viewport: { width: WIDTH, height: HEIGHT },
        colorScheme: scheme,
        reducedMotion: "reduce",
        serviceWorkers: "allow",
        locale: "en-ZW",
        timezoneId: "Africa/Harare",
      });
      await context.clock.install({ time: NOW });
      await mockNetwork(context);
      const hero = "[data-sky-hero]:not([data-skeleton])";
      const settle = async (page) => {
        await page.waitForSelector(hero, { timeout: 30000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(9000);
      };
      // Online: install the worker, let it store the page and precache the files.
      const online = await context.newPage();
      await online.goto(BASE + "/", { waitUntil: "load" });
      await online.evaluate(() => navigator.serviceWorker.ready);
      await online.waitForTimeout(8000);
      await online.reload({ waitUntil: "load" });
      await settle(online);
      const onlineStyles = await online.evaluate(READ_STYLES);
      await online.close();
      // Offline: a new page, no network at all.
      await context.setOffline(true);
      const page = await context.newPage();
      await page
        .goto(BASE + "/", { waitUntil: "domcontentloaded" })
        .catch(() => {});
      await settle(page);
      const offlineStyles = await page.evaluate(READ_STYLES);
      // The whole sheet is in: a linked stylesheet from /_next/static/css with
      // far more rules than the font sheet beside it.
      const wholeSheet = await page.evaluate(() =>
        [...document.styleSheets].some((sheet) => {
          try {
            return (
              /\/_next\/static\/css\/[0-9a-f]{16}\.css$/.test(
                sheet.href ?? "",
              ) && sheet.cssRules.length > 100
            );
          } catch {
            return false;
          }
        }),
      );
      const heroShown = (await page.$(hero)) !== null;
      await context.close();
      const pairs = align(
        onlineStyles.map(([label]) => label),
        offlineStyles.map(([label]) => label),
      );
      // One difference is not ours: the logo image's text colour (what its alt
      // text would be drawn in) is `transparent` online and inherited offline, in
      // dark mode, on staging as well. It is listed and not counted.
      const knownImgColour = ([i, j]) => {
        if (!onlineStyles[i][0].startsWith("img.")) return false;
        const A = new Map(
          onlineStyles[i][1].split(";").map((x) => x.split(/:(.*)/s)),
        );
        const B = new Map(
          offlineStyles[j][1].split(";").map((x) => x.split(/:(.*)/s)),
        );
        return [...new Set([...A.keys(), ...B.keys()])]
          .filter((k) => A.get(k) !== B.get(k))
          .every((k) => /(^|-)(color|fill-color|stroke-color)$/.test(k));
      };
      const all = pairs.filter(
        ([i, j]) => onlineStyles[i][1] !== offlineStyles[j][1],
      );
      const different = all.filter((pair) => !knownImgColour(pair));
      const ok = different.length === 0 && wholeSheet && heroShown;
      for (const [i, j] of all.slice(0, 6)) {
        const A = new Map(
          onlineStyles[i][1].split(";").map((x) => x.split(/:(.*)/s)),
        );
        const B = new Map(
          offlineStyles[j][1].split(";").map((x) => x.split(/:(.*)/s)),
        );
        const props = [...new Set([...A.keys(), ...B.keys()])].filter(
          (k) => A.get(k) !== B.get(k),
        );
        console.log(
          `        ${onlineStyles[i][0]} ${props
            .slice(0, 4)
            .map((p) => `${p}: ${A.get(p)} -> ${B.get(p)}`)
            .join("; ")}`,
        );
      }
      if (!ok) failures++;
      console.log(
        `${ok ? "PASS" : "FAIL"}  offline-${scheme}: ${pairs.length} elements compared, ${different.length} differ; whole sheet applied: ${wholeSheet}; weather shown offline: ${heroShown}`,
      );
    }
  } finally {
    await browser.close();
  }
  process.exit(failures ? 1 : 0);
}

async function shoot() {
  const dir = join(SHOTS, LABEL);
  await mkdir(dir, { recursive: true });
  const browser = await launch();
  try {
    for (const route of ROUTES)
      for (const scheme of SCHEMES)
        for (const visit of VISITS) {
          const id = name(route, scheme, visit);
          if (ONLY && !id.includes(ONLY)) continue;
          const { context, page } = await loadScenario(
            browser,
            route,
            scheme,
            visit,
            HOLD_REST,
          );
          await page.screenshot({
            path: join(dir, `${id}.png`),
            animations: "disabled",
          });
          await page.screenshot({
            path: join(dir, `${id}-full.png`),
            animations: "disabled",
            fullPage: true,
          });
          await context.close();
          console.log(`shot ${id}`);
        }
  } finally {
    await browser.close();
  }
}

/** Pixel difference of two PNGs, decoded in a page: count, share, bounding box. */
async function diff(a, b) {
  const browser = await launch();
  const helper = await (await browser.newContext()).newPage();
  await helper.goto("about:blank");
  let failures = 0;
  try {
    const files = (await readdir(join(SHOTS, a))).filter((f) =>
      f.endsWith(".png"),
    );
    for (const file of files) {
      const read = async (dir) =>
        (await readFile(join(SHOTS, dir, file)).catch(() => null))?.toString(
          "base64",
        );
      const [pa, pb] = [await read(a), await read(b)];
      if (!pa || !pb) {
        console.log(`FAIL  ${file}: missing in ${!pa ? a : b}`);
        failures++;
        continue;
      }
      const result = await helper.evaluate(
        async ([x, y]) => {
          const load = async (b64) =>
            createImageBitmap(
              await (await fetch(`data:image/png;base64,${b64}`)).blob(),
            );
          const [ia, ib] = [await load(x), await load(y)];
          if (ia.width !== ib.width || ia.height !== ib.height)
            return { size: [ia.width, ia.height, ib.width, ib.height] };
          const draw = (img) => {
            const c = new OffscreenCanvas(img.width, img.height);
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            return g.getImageData(0, 0, img.width, img.height).data;
          };
          const [da, db] = [draw(ia), draw(ib)];
          let count = 0;
          let max = 0;
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -1;
          let maxY = -1;
          for (let i = 0; i < da.length; i += 4) {
            const d = Math.max(
              Math.abs(da[i] - db[i]),
              Math.abs(da[i + 1] - db[i + 1]),
              Math.abs(da[i + 2] - db[i + 2]),
              Math.abs(da[i + 3] - db[i + 3]),
            );
            if (!d) continue;
            count++;
            max = Math.max(max, d);
            const px = (i / 4) % ia.width;
            const py = Math.floor(i / 4 / ia.width);
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
          }
          return {
            total: da.length / 4,
            count,
            max,
            box: count ? [minX, minY, maxX, maxY] : null,
          };
        },
        [pa, pb],
      );
      const same = !result.size && result.count === 0;
      if (!same) failures++;
      console.log(
        `${same ? "PASS" : "FAIL"}  ${file}: ${
          result.size
            ? `size ${result.size.slice(0, 2)} vs ${result.size.slice(2)}`
            : `${result.count} of ${result.total} pixels differ` +
              (result.count
                ? `, largest channel change ${result.max}, in box ${result.box}`
                : "")
        }`,
      );
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} images differ` : "\nno differences");
  process.exit(failures ? 1 : 0);
}

const [mode, argA, argB] = process.argv.slice(2);
if (mode === "coverage") await coverage();
else if (mode === "offline") await offline();
else if (mode === "shoot") await shoot();
else if (mode === "diff" && argA && argB) await diff(argA, argB);
else {
  console.error(
    "usage: critical-css.mjs coverage | offline | shoot | diff <labelA> <labelB>",
  );
  process.exit(2);
}
