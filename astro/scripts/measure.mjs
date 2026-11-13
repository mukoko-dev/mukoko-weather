// Lab measurement of a page's first screen on a throttled mid-range phone:
// Chromium with a Pixel 5 profile, Slow 4G (1.6 Mbps, 150 ms) and a 4x CPU
// slowdown, as in #551. Derived from the coordinator's harness
// (perf-shell.cjs); adds the JavaScript heap, DOM nodes, script CPU time and
// the inline script bytes, and takes the median of several runs.
//
// Two scenarios per run: COLD (first visit, empty cache, no service worker)
// and WARM (a second open in the same browser context after eight seconds, so a
// service worker has installed and the HTTP cache is filled).
//
//   node scripts/measure.mjs --url http://127.0.0.1:4321 --path /about \
//        --label astro --runs 3 [--out dir] [--film]
//
// For the Astro build, serve dist/client with scripts/serve-dist.mjs (it gzips
// like Cloudflare's edge); for the Next.js build use `next start`. Numbers are a
// lab measurement on one machine: compare two runs of this script made on the
// same machine, minutes apart, never against another machine's numbers.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, devices } from "./browser.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--"))
      acc.push([
        a.slice(2),
        all[i + 1]?.startsWith("--") || all[i + 1] === undefined
          ? true
          : all[i + 1],
      ]);
    return acc;
  }, []),
);
const base = args.url ?? "http://127.0.0.1:4321";
const route = args.path ?? "/about";
const label = args.label ?? "page";
const runs = Number(args.runs ?? 3);
const outDir = args.out ?? `perf-out/${label}`;
const film = Boolean(args.film);
const settleMs = Number(args.settle ?? 6000);

const NET = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
};
const CPU = 4;

const INIT = () => {
  window.__perf = { fcp: null, lcp: null, cls: 0, longTasks: [] };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        if (e.name === "first-contentful-paint")
          window.__perf.fcp = e.startTime;
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__perf.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        if (!e.hadRecentInput) window.__perf.cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        window.__perf.longTasks.push([
          Math.round(e.startTime),
          Math.round(e.duration),
        ]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
};

// The lower median: with an even number of runs, the faster of the middle two.
const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

async function throttle(cdp) {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", NET);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
}

async function startFilm(cdp, prefix) {
  const frames = [];
  cdp.on("Page.screencastFrame", (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data });
    cdp
      .send("Page.screencastFrameAck", { sessionId: f.sessionId })
      .catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 45,
    maxWidth: 393,
    maxHeight: 851,
    everyNthFrame: 1,
  });
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    const t0 = frames[0]?.t ?? 0;
    await Promise.all(
      frames.map((f, i) =>
        writeFile(
          `${prefix}-${String(i).padStart(3, "0")}-${Math.round(f.t - t0)}ms.jpg`,
          Buffer.from(f.data, "base64"),
        ),
      ),
    );
    return frames.map((f) => Math.round(f.t - t0));
  };
}

async function snapshot(page, cdp) {
  await page.waitForTimeout(settleMs);
  const page_ = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const kinds = {
      js: [0, 0, 0],
      css: [0, 0, 0],
      font: [0, 0, 0],
      img: [0, 0, 0],
      other: [0, 0, 0],
    };
    for (const e of performance.getEntriesByType("resource")) {
      const k =
        /\.m?js(\?|$)/.test(e.name) || e.initiatorType === "script"
          ? "js"
          : /\.css(\?|$)/.test(e.name)
            ? "css"
            : /\.(woff2?|ttf)(\?|$)/.test(e.name)
              ? "font"
              : /\.(png|jpe?g|svg|webp|avif|gif|ico)(\?|$)/.test(e.name)
                ? "img"
                : "other";
      kinds[k][0]++;
      kinds[k][1] += e.transferSize || 0;
      kinds[k][2] += e.decodedBodySize || 0;
    }
    const inlineJs = [...document.scripts]
      .filter((s) => !s.src)
      .reduce((n, s) => n + new Blob([s.textContent]).size, 0);
    return {
      ttfb: Math.round(nav.responseStart),
      htmlDone: Math.round(nav.responseEnd),
      domInteractive: Math.round(nav.domInteractive),
      load: Math.round(nav.loadEventEnd),
      fcp: window.__perf.fcp && Math.round(window.__perf.fcp),
      lcp: window.__perf.lcp && Math.round(window.__perf.lcp),
      cls: +window.__perf.cls.toFixed(3),
      longTasks: window.__perf.longTasks.length,
      longTaskMs: window.__perf.longTasks.reduce((a, b) => a + b[1], 0),
      jsFiles: kinds.js[0],
      jsTransfer: kinds.js[1],
      jsDecoded: kinds.js[2],
      inlineJs,
      cssTransfer: kinds.css[1],
      cssDecoded: kinds.css[2],
      fontFiles: kinds.font[0],
      htmlTransfer: nav.transferSize,
      textLength: document.body.innerText.length,
    };
  });
  const metrics = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
  const heapBeforeGc = metrics.JSHeapUsedSize;
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const after = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
  return {
    ...page_,
    heapUsedMB: +(after.JSHeapUsedSize / 1048576).toFixed(2),
    heapUsedBeforeGcMB: +(heapBeforeGc / 1048576).toFixed(2),
    domNodes: after.Nodes,
    scriptMs: Math.round(after.ScriptDuration * 1000),
    taskMs: Math.round(after.TaskDuration * 1000),
  };
}

async function openPage(context, url) {
  const page = await context.newPage();
  await page.addInitScript(INIT);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await throttle(cdp);
  return { page, cdp, url };
}

await mkdir(outDir, { recursive: true });
const browser = await launch();
const all = { cold: [], warm: [] };
try {
  for (let i = 0; i < runs; i++) {
    const context = await browser.newContext({
      ...devices["Pixel 5"],
      serviceWorkers: "allow",
    });
    const cold = await openPage(context, base + route);
    const stopCold = film
      ? await startFilm(cold.cdp, join(outDir, `cold-${i}`))
      : null;
    await cold.page.goto(cold.url, { waitUntil: "commit" });
    all.cold.push(await snapshot(cold.page, cold.cdp));
    if (stopCold) await stopCold();
    await cold.page.waitForTimeout(8000);
    const warm = await openPage(context, base + route);
    const stopWarm = film
      ? await startFilm(warm.cdp, join(outDir, `warm-${i}`))
      : null;
    await warm.page.goto(warm.url, { waitUntil: "commit" });
    all.warm.push(await snapshot(warm.page, warm.cdp));
    if (stopWarm) await stopWarm();
    await context.close();
    console.error(`run ${i + 1}/${runs} done`);
  }
} finally {
  await browser.close();
}

const summary = {
  label,
  base,
  route,
  runs,
  profile: "Pixel 5, Slow 4G 1.6 Mbps 150 ms, CPU 4x",
};
for (const scenario of ["cold", "warm"]) {
  const keys = Object.keys(all[scenario][0]);
  summary[scenario] = Object.fromEntries(
    keys.map((k) => [k, median(all[scenario].map((r) => r[k]))]),
  );
}
await writeFile(
  join(outDir, "summary.json"),
  JSON.stringify({ summary, runs: all }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
