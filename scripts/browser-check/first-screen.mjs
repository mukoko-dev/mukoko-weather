// How fast the home page's first screen arrives on a throttled mid-range phone
// (issue #551). The same profile as `astro/scripts/measure.mjs`, the Phase 0
// harness: Chromium with a Pixel 5 profile, Slow 4G (1.6 Mbps, 150 ms) and a
// 4x CPU slowdown; a COLD open (empty cache, no service worker) and a WARM one
// (a second open in the same browser context eight seconds later, with the
// worker installed and the forecast stored on the device); the lower median of
// the runs.
//
// What `measure.mjs` cannot say, because it is given a URL and nothing else:
// WHEN THE REAL WEATHER IS ON SCREEN. A lab machine cannot reach the weather
// API (it answers the visitor's own browser), so this script answers the
// Worker's routes itself (`mockNetwork`: one realistic forecast, the size of a
// real one), after the delay a real answer takes on this link: the round trip
// plus the gzipped body. The page's own files come from the server under test,
// through the throttled link.
//
// The Google tag is part of the page, so it is part of the measurement. The
// lab answers every host that is not the app's own, and used to refuse this
// one, which left out the largest third-party cost: gtag.js for the app's GA4
// property is 181 KB gzipped and 542 KB to parse. `gtag-standin.mjs` generates
// a stand-in of that size at run time (nothing large is committed), serves it
// from this machine through the throttled link, and the request for the real
// host is redirected to it. It stands in for the tag's bytes and its parse, not
// for what the real tag does once it runs, and not for the DNS and TLS set-up
// to Google's host: read its header. `GTAG=none` restores the old refusal (to
// compare with numbers taken before this existed), `GTAG_FILE=<path>` serves a
// copy of the real tag that you saved yourself.
//
// Serve the production build on the machine's own address, not on loopback:
// Chromium does not throttle everything a loopback server answers (what
// JavaScript asks for, such as a dynamic import, arrives at once). That
// address is not a secure context, so the service worker needs it declared as
// one, and only the full Chrome binary honours that flag, not Playwright's
// headless shell:
//
//   npm run build && npx next start -p 3151        # listens on every address
//   BASE=http://<this machine's address>:3151 \
//   CHROME_PATH=/path/to/chrome-linux64/chrome \
//   RUNS=3 SETTLE=12000 LABEL=before node scripts/browser-check/first-screen.mjs
//
// Other settings: ROUTE (default /), COLOR_SCHEME (light or dark: the phone's
// setting), SEED_THEME (light or dark: the theme the person chose in the app,
// written where the app keeps it, in IndexedDB, after the first visit, then one
// more visit so the app can record it, before the WARM one: a person who chose
// dark on a light phone), FILM=1 (record the screen and print its brightness
// over time: a pale frame followed by a dark one is a flash), FILM_SAVE=1 (also
// keep every frame as a JPEG under OUT/film), GTAG (standin, the default, or
// none: see above), GTAG_FILE, OUT (where <LABEL>.json goes; the full runs are
// there).
//
// Reports, per scenario (milliseconds from the start of the navigation):
//   fcp, lcp           first and largest paint
//   weather            when the real hero (not the skeleton) is on screen
//   themeAtFcp, themeFlipMs   the page's theme at first paint, and how long
//                      after it the theme changed (0: it did not: no flash)
//   threeStart/End     when the Three.js chunks were requested / finished
//   threeAfterWeather  how long after the weather the first of them was asked for
//   blocked*           sum of long tasks: in the whole window, before the real
//                      weather is on screen, and in the 1.5 s after it
//   gtagStart/End      when the Google tag was requested / finished arriving
//   jsTransferKB ...   the app's JavaScript on the wire and decoded (the Google
//                      tag is counted apart: gtagTransferKB), the JS heap
//                      after a forced garbage collection, DOM nodes, script time
// The full runs in OUT/<LABEL>.json also hold every long task as [start,
// duration] (longTaskList).
// Numbers are a lab measurement on one machine: compare two runs made on the
// same machine, minutes apart, never against another machine's numbers.
import { createRequire } from "node:module";
import zlib from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BASE } from "./harness.mjs";
import { mockNetwork, weatherPayload } from "./memory-harness.mjs";
import { GTAG_HOST, routeGtag, serveGtag } from "./gtag-standin.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const RUNS = Number(process.env.RUNS ?? 3);
const LABEL = process.env.LABEL ?? "run";
const FILM_SAVE = Boolean(process.env.FILM_SAVE);
const FILM = Boolean(process.env.FILM) || FILM_SAVE;
const PATH_ = process.env.ROUTE ?? "/";
const SETTLE_MS = Number(process.env.SETTLE ?? 12000);
const OUT =
  process.env.OUT ?? join(process.env.TMPDIR ?? "/tmp", "first-screen");
const COLOR_SCHEME = process.env.COLOR_SCHEME ?? "light";
const SEED_THEME = process.env.SEED_THEME ?? "";
const IDB_OPEN_DELAY_MS = Number(process.env.IDB_OPEN_DELAY ?? 0);
const SERVICE_WORKERS =
  process.env.SERVICE_WORKERS === "block" ? "block" : "allow";
const GTAG = process.env.GTAG === "none" ? "none" : "standin";

const LINK = {
  latency: 150,
  down: (1.6 * 1024 * 1024) / 8,
  up: (750 * 1024) / 8,
};
const CPU = 4;

/** Observers installed before any page script runs. */
const INIT = () => {
  const perf = (window.__perf = {
    fcp: null,
    lcp: null,
    cls: 0,
    longTasks: [],
    weatherAt: null,
    theme: [],
  });
  // Each change of the theme attribute (a flip after first paint is the flash).
  const note = () => {
    const now = document.documentElement.getAttribute("data-theme");
    if (perf.theme.at(-1)?.[1] !== now)
      perf.theme.push([Math.round(performance.now()), now]);
  };
  // `documentElement` does not exist yet when this script runs.
  const onRoot = (fn) => {
    if (document.documentElement) return fn();
    const mo = new MutationObserver(() => {
      if (!document.documentElement) return;
      mo.disconnect();
      fn();
    });
    mo.observe(document, { childList: true });
  };
  try {
    onRoot(() => {
      note();
      new MutationObserver(note).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class"],
      });
    });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        if (e.name === "first-contentful-paint") perf.fcp = e.startTime;
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) perf.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        if (!e.hadRecentInput) perf.cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        perf.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: "longtask", buffered: true });
    // The real hero: CurrentConditions carries `data-sky-hero`, the skeleton
    // carries it too but also `data-skeleton`.
    const looksReal = () =>
      document.querySelector("[data-sky-hero]:not([data-skeleton])") !== null;
    const mo = new MutationObserver(() => {
      if (perf.weatherAt === null && looksReal()) {
        // After the frame that shows it, not before.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            perf.weatherAt ??= Math.round(performance.now());
          }),
        );
        mo.disconnect();
      }
    });
    onRoot(() =>
      mo.observe(document.documentElement, { childList: true, subtree: true }),
    );
  } catch {
    // an observer type this Chromium lacks
  }
};

const lower = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

async function throttle(cdp) {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: LINK.latency,
    downloadThroughput: LINK.down,
    uploadThroughput: LINK.up,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
}

/** Delay the Worker's forecast as a real answer on this link would be. */
async function slowForecast(context) {
  await context.route(
    "https://weather-api.mukoko.com/v1/weather*",
    async (route) => {
      const url = new URL(route.request().url());
      const lat = Number(url.searchParams.get("lat")) || -17.83;
      const lon = Number(url.searchParams.get("lon")) || 31.05;
      const gz = zlib.gzipSync(JSON.stringify(weatherPayload(lat, lon))).length;
      const ms = LINK.latency + (gz / LINK.down) * 1000;
      await new Promise((r) => setTimeout(r, ms));
      await route.fallback();
    },
  );
}

async function openPage(context) {
  const page = await context.newPage();
  await page.addInitScript(INIT);
  if (IDB_OPEN_DELAY_MS > 0) {
    // The success of an `indexedDB.open` reaches its handler late.
    await page.addInitScript((ms) => {
      // One late copy of each handler, so removeEventListener still finds it.
      const late = new WeakMap();
      const wrap = (fn) => {
        if (typeof fn !== "function") return fn;
        if (!late.has(fn))
          late.set(fn, function (event) {
            setTimeout(() => fn.call(this, event), ms);
          });
        return late.get(fn);
      };
      const own = Object.getOwnPropertyDescriptor(
        IDBRequest.prototype,
        "onsuccess",
      );
      Object.defineProperty(IDBRequest.prototype, "onsuccess", {
        configurable: true,
        get: own.get,
        set(fn) {
          own.set.call(this, this instanceof IDBOpenDBRequest ? wrap(fn) : fn);
        },
      });
      const late_ = (self, type) =>
        self instanceof IDBOpenDBRequest && type === "success";
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (type, fn, opts) {
        return add.call(this, type, late_(this, type) ? wrap(fn) : fn, opts);
      };
      EventTarget.prototype.removeEventListener = function (type, fn, opts) {
        return remove.call(this, type, late_(this, type) ? wrap(fn) : fn, opts);
      };
    }, IDB_OPEN_DELAY_MS);
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await throttle(cdp);
  return { page, cdp };
}

async function startFilm(cdp) {
  const frames = [];
  cdp.on("Page.screencastFrame", (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data });
    cdp
      .send("Page.screencastFrameAck", { sessionId: f.sessionId })
      .catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: FILM_SAVE ? 60 : 40,
    maxWidth: FILM_SAVE ? 393 : 196,
    maxHeight: FILM_SAVE ? 851 : 425,
    everyNthFrame: 1,
  });
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    return frames;
  };
}

/** Mean brightness (0 to 255) of each screencast frame, decoded in a helper page. */
async function brightness(helper, frames) {
  const t0 = frames[0]?.t ?? 0;
  const out = [];
  for (const f of frames) {
    const lum = await helper.evaluate(async (b64) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(40, 80);
      const x = c.getContext("2d");
      x.drawImage(bmp, 0, 0, 40, 80);
      const d = x.getImageData(0, 0, 40, 80).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4)
        s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return Math.round(s / (d.length / 4));
    }, f.data);
    out.push([Math.round(f.t - t0), lum]);
  }
  return out;
}

/**
 * The script files that hold Three.js (the library itself: two chunks of about
 * 350 KB, not a small module that only names the renderer), found by reading
 * each file once from the server, outside the measured page.
 */
const holdsThree = new Map();
async function threeChunks(chunks) {
  const found = [];
  for (const chunk of chunks) {
    if (!holdsThree.has(chunk.url)) {
      const text = await fetch(chunk.url)
        .then((r) => r.text())
        .catch(() => "");
      holdsThree.set(
        chunk.url,
        text.length > 100_000 && text.includes("WebGLRenderer"),
      );
    }
    if (holdsThree.get(chunk.url)) found.push(chunk);
  }
  return found;
}

/**
 * Write the theme a person chose in the app where the app keeps it: the
 * `preferences` document in IndexedDB (found by listing the databases, as in
 * memory-harness.mjs), as the app does when a visitor picks "dark".
 */
async function seedTheme(page, theme) {
  const result = await page.evaluate(async (theme) => {
    const names = (await indexedDB.databases()).map((d) => d.name);
    const name = names.find((n) => /^rxdb-dexie-.*--preferences$/.test(n));
    if (!name) return { ok: false, why: `no preferences database in ${names}` };
    return new Promise((resolve) => {
      const open = indexedDB.open(name);
      open.onerror = () => resolve({ ok: false, why: "cannot open" });
      open.onsuccess = () => {
        const store = open.result
          .transaction("docs", "readwrite")
          .objectStore("docs");
        const all = store.getAll();
        all.onsuccess = () => {
          const doc = all.result[0];
          if (!doc) return resolve({ ok: false, why: "no document" });
          Object.assign(doc, { theme, updatedAt: Date.now() });
          store.put(doc).onsuccess = () => resolve({ ok: true });
        };
      };
    });
  }, theme);
  if (!result.ok)
    throw new Error(
      `SEED_THEME: ${result.why}; the preferences store changed.`,
    );
}

async function snapshot(page, cdp) {
  await page.waitForTimeout(SETTLE_MS);
  const inPage = await page.evaluate(async (gtagHost) => {
    const nav = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    let js = [0, 0, 0];
    let css = [0, 0, 0];
    let tag = [0, 0, 0, null, null];
    for (const e of res) {
      // The Google tag is another party's file: counted apart.
      if (new URL(e.name).hostname === gtagHost) {
        tag[0]++;
        tag[1] += e.transferSize || 0;
        tag[2] += e.decodedBodySize || 0;
        tag[3] = Math.round(e.startTime);
        tag[4] = Math.round(e.responseEnd);
        continue;
      }
      const isJs = /\.m?js(\?|$)/.test(e.name) || e.initiatorType === "script";
      const isCss = /\.css(\?|$)/.test(e.name);
      const bucket = isJs ? js : isCss ? css : null;
      if (!bucket) continue;
      bucket[0]++;
      bucket[1] += e.transferSize || 0;
      bucket[2] += e.decodedBodySize || 0;
    }
    // The page's own script files; which of them hold Three.js is decided
    // outside the page (`threeChunks`), so the measured page does no extra work.
    const chunks = res
      .filter((e) => /\/_next\/static\/chunks\/.*\.js/.test(e.name))
      .map((e) => ({
        url: e.name,
        start: Math.round(e.startTime),
        end: Math.round(e.responseEnd),
        decoded: e.decodedBodySize || 0,
      }));
    const long = window.__perf.longTasks;
    const weatherAt = window.__perf.weatherAt;
    const sum = (from, to) =>
      long
        .filter(([start]) => start >= from && start < to)
        .reduce((a, [, d]) => a + d, 0);
    const bg = (el) => getComputedStyle(el).backgroundColor;
    // The theme at first paint and the first change after it (a flash).
    const fcpAt = window.__perf.fcp ?? 0;
    const log = window.__perf.theme;
    const atFcp = [...log].reverse().find(([t]) => t <= fcpAt)?.[1] ?? null;
    const flip = log.find(([t, v]) => t > fcpAt && v !== atFcp);
    return {
      themeAtFcp: atFcp,
      themeFlipMs: flip ? Math.round(flip[0] - fcpAt) : 0,
      ttfb: Math.round(nav.responseStart),
      htmlDone: Math.round(nav.responseEnd),
      fcp: window.__perf.fcp && Math.round(window.__perf.fcp),
      lcp: window.__perf.lcp && Math.round(window.__perf.lcp),
      cls: +window.__perf.cls.toFixed(3),
      weather: weatherAt,
      chunks,
      longTasks: long.length,
      longTaskList: long,
      blockedMs: sum(0, Infinity),
      blockedBeforeWeatherMs: weatherAt === null ? null : sum(0, weatherAt),
      blockedAfterWeatherMs:
        weatherAt === null ? null : sum(weatherAt, weatherAt + 1500),
      jsFiles: js[0],
      jsTransferKB: Math.round(js[1] / 1024),
      jsDecodedKB: Math.round(js[2] / 1024),
      cssTransferKB: Math.round(css[1] / 1024),
      gtagFiles: tag[0],
      gtagTransferKB: Math.round(tag[1] / 1024),
      gtagDecodedKB: Math.round(tag[2] / 1024),
      gtagStart: tag[3],
      gtagEnd: tag[4],
      theme: window.__perf.theme,
      htmlBg: bg(document.documentElement),
      bodyBg: bg(document.body),
      hasCanvas: document.querySelectorAll("canvas").length,
    };
  }, GTAG_HOST);
  const { chunks, ...rest } = inPage;
  const three = await threeChunks(chunks);
  const first = three.length ? Math.min(...three.map((c) => c.start)) : null;
  const inPageWithThree = {
    ...rest,
    threeStart: first,
    threeEnd: three.length ? Math.max(...three.map((c) => c.end)) : null,
    threeAfterWeather:
      first !== null && rest.weather !== null ? first - rest.weather : null,
    threeKB: Math.round(three.reduce((a, c) => a + c.decoded, 0) / 1024),
  };
  const read = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
        m.name,
        m.value,
      ]),
    );
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const m = await read();
  return {
    ...inPageWithThree,
    heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1),
    domNodes: m.Nodes,
    scriptMs: Math.round(m.ScriptDuration * 1000),
  };
}

await mkdir(OUT, { recursive: true });
// Chromium's network throttling is only complete for a server that is not on
// loopback: against 127.0.0.1 the page's own requests that JavaScript makes
// (dynamic imports, fetch) arrive instantly and only the CPU slowdown and the
// first load are slowed. Serve the build on the machine's own address
// (`next start`, BASE=http://<that address>:3151). That origin is not a secure
// context, so the service worker needs it declared as one, and only the full
// Chrome binary (CHROME_PATH=.../chrome-linux64/chrome), not Playwright's
// headless shell, honours that flag.
const loopback = /^(localhost|127\.|\[?::1)/.test(new URL(BASE).hostname);
if (loopback)
  console.error(
    "WARNING: BASE is a loopback address, so the network is only partly " +
      "throttled. Use the machine's own address (see the header).",
  );
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: loopback
    ? []
    : [`--unsafely-treat-insecure-origin-as-secure=${new URL(BASE).origin}`],
});
// The Google tag's stand-in, served from this machine (see the header).
const gtag =
  GTAG === "none"
    ? null
    : await serveGtag({
        host: new URL(BASE).hostname,
        file: process.env.GTAG_FILE,
      });
if (gtag)
  console.error(
    `Google tag: ${gtag.fromFile ? "file " + process.env.GTAG_FILE : "generated stand-in"}, ${gtag.decodedKB} KB decoded, ${gtag.gzipKB} KB gzipped, served at ${gtag.origin}`,
  );
const helperCtx = await browser.newContext();
const helper = await helperCtx.newPage();
await helper.goto("about:blank");
const all = { cold: [], warm: [] };
const films = { cold: [], warm: [] };
try {
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext({
      ...devices["Pixel 5"],
      colorScheme: COLOR_SCHEME,
      serviceWorkers: SERVICE_WORKERS,
    });
    await mockNetwork(context);
    await slowForecast(context);
    if (gtag) await routeGtag(context, gtag);
    for (const scenario of ["cold", "warm"]) {
      const { page, cdp } = await openPage(context);
      const stop = FILM ? await startFilm(cdp) : null;
      await page.goto(BASE + PATH_, { waitUntil: "commit" });
      const snap = await snapshot(page, cdp);
      if (stop) {
        const frames = await stop();
        films[scenario].push(await brightness(helper, frames));
        if (FILM_SAVE) {
          const t0 = frames[0]?.t ?? 0;
          await mkdir(join(OUT, "film"), { recursive: true });
          await Promise.all(
            frames.map((f, n) =>
              writeFile(
                join(
                  OUT,
                  "film",
                  `${LABEL}-${scenario}-${i}-${String(n).padStart(3, "0")}-${Math.round(f.t - t0)}ms.jpg`,
                ),
                Buffer.from(f.data, "base64"),
              ),
            ),
          );
        }
      }
      all[scenario].push(snap);
      if (scenario === "cold" && SEED_THEME) await seedTheme(page, SEED_THEME);
      await page.close();
      if (scenario === "cold") {
        await new Promise((r) => setTimeout(r, 8000));
        if (SEED_THEME) {
          // One more visit, so the app reads the theme from IndexedDB and can
          // record it for the next one (the warm visit measured below).
          const again = await openPage(context);
          await again.page.goto(BASE + PATH_, { waitUntil: "commit" });
          await again.page.waitForTimeout(6000);
          await again.page.close();
        }
      }
    }
    await context.close();
    console.error(`run ${i + 1}/${RUNS} done`);
  }
} finally {
  await browser.close();
  await gtag?.close();
}

const summary = { label: LABEL, base: BASE, route: PATH_, runs: RUNS };
for (const scenario of ["cold", "warm"]) {
  const keys = Object.keys(all[scenario][0]).filter(
    (k) =>
      typeof all[scenario][0][k] !== "object" || all[scenario][0][k] === null,
  );
  summary[scenario] = Object.fromEntries(
    keys.map((k) => [
      k,
      typeof all[scenario][0][k] === "string"
        ? all[scenario].map((r) => r[k]).join(" | ")
        : lower(all[scenario].map((r) => r[k])),
    ]),
  );
  if (FILM)
    summary[`${scenario}Film`] = films[scenario].map((f) => {
      const pts = [];
      let last = -999;
      for (const [t, l] of f)
        if (Math.abs(l - last) > 5) {
          pts.push(`${t}:${l}`);
          last = l;
        }
      return pts.join(" ");
    });
}
// A metric that one run could not read is reported from the others: say so.
summary.warnings = [];
for (const scenario of ["cold", "warm"])
  for (const key of ["weather", "fcp"]) {
    const missing = all[scenario].filter((r) => r[key] == null).length;
    if (missing)
      summary.warnings.push(
        `${scenario} ${key}: not read in ${missing} of ${RUNS} runs`,
      );
  }
if (gtag)
  for (const scenario of ["cold", "warm"]) {
    const missing = all[scenario].filter((r) => r.gtagFiles === 0).length;
    if (missing)
      summary.warnings.push(
        `${scenario}: the page did not ask for the Google tag in ${missing} of ${RUNS} runs, so this number leaves it out (does the app still load it from ${GTAG_HOST}?)`,
      );
  }
const themeLog = {
  cold: all.cold.map((r) => JSON.stringify(r.theme)),
  warm: all.warm.map((r) => JSON.stringify(r.theme)),
};
summary.themeChanges = themeLog;
await writeFile(
  join(OUT, `${LABEL}.json`),
  JSON.stringify({ summary, runs: all }, null, 2),
);
for (const k of ["cold", "warm"]) console.log(k, JSON.stringify(summary[k]));
for (const k of ["coldFilm", "warmFilm", "themeChanges"])
  if (summary[k]) console.log(k, JSON.stringify(summary[k]));
if (summary.warnings.length)
  console.log("WARNINGS", summary.warnings.join("; "));
