// Shared helpers for the memory budget check (issue #476).
//
// Everything the page asks of the network is answered here, so a run spends no
// provider quota and the numbers do not depend on the weather: the Worker's
// routes get one realistic payload (`weatherPayload`), map tiles get a small
// PNG, analytics and anything else is refused.
//
// What is measured (Chrome DevTools Protocol, after a forced garbage
// collection each time): the JS heap, DOM nodes, event listeners, the number
// and pixel size of live canvases, and the WebGL contexts that are still alive.
// What is NOT measured: a real phone. This is a desktop Chromium in an iPhone
// (or Pixel) profile; see README.md.
import zlib from "node:zlib";
import { BASE, chromium } from "./harness.mjs";

export const PROFILES = {
  iphone: {
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  pixel: {
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  },
};

export const SAVED_PLACES = [
  "bulawayo",
  "nairobi-ke",
  "lagos-ng",
  "cape-town-za",
  "singapore-sg",
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ PNG tiles
// CRC-32 (the PNG one), computed here: zlib.crc32 only exists from Node 20.15 /
// 22.2, and this check should run on whatever Node Playwright runs on.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A flat-colour RGBA PNG: a stand-in for a map tile. */
function png(size, [r, g, b, a]) {
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) row.set([r, g, b, a], 1 + x * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const TILE = png(256, [120, 160, 200, 140]);

// ------------------------------------------------------------- the forecast
const CODES = [0, 2, 61, 3, 95, 45, 71, 51];

/**
 * A full `/v1/weather` answer: 7 days hourly, the daily block, insights, the
 * nowcast and six models' comparison series (the size of a real one). The
 * weather code depends on the point, so neighbouring places draw different
 * skies, which is the worst case for place switching.
 */
export function weatherPayload(lat, lon, offsetSeconds = 7200) {
  const code =
    CODES[
      Math.abs(Math.round(lat * 10) * 31 + Math.round(lon * 10) * 17) %
        CODES.length
    ];
  const local = new Date(Date.now() + offsetSeconds * 1000);
  const day0 = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  const hours = 168;
  const series = (f) => Array.from({ length: hours }, (_, i) => f(i));
  const temp = (i) =>
    +(18 + 8 * Math.sin((((i % 24) - 9) / 24) * 2 * Math.PI)).toFixed(1);
  const time = series((i) => iso(day0 + i * 3600e3));
  const hourly = {
    time,
    temperature_2m: series(temp),
    apparent_temperature: series((i) => temp(i) - 1),
    relative_humidity_2m: series((i) => 50 + (i % 24)),
    precipitation_probability: series((i) => (i % 24 > 14 ? 40 : 5)),
    precipitation: series((i) => (i % 24 > 14 && code >= 51 ? 0.4 : 0)),
    weather_code: series(() => code),
    visibility: series(() => 24000),
    cloud_cover: series((i) => (i * 7) % 100),
    surface_pressure: series((i) => 1012 + (i % 6)),
    wind_speed_10m: series((i) => 8 + (i % 9)),
    wind_direction_10m: series((i) => (i * 13) % 360),
    wind_gusts_10m: series((i) => 15 + (i % 11)),
    uv_index: series((i) => (i % 24 > 6 && i % 24 < 18 ? 8 : 0)),
    is_day: series((i) => (i % 24 >= 6 && i % 24 < 18 ? 1 : 0)),
    dew_point_2m: series((i) => 10 + (i % 4)),
  };
  const days = Array.from({ length: 7 }, (_, i) => date(day0 + i * 86400e3));
  const daily = {
    time: days,
    weather_code: days.map(() => code),
    temperature_2m_max: days.map((_, i) => 27 + (i % 3)),
    temperature_2m_min: days.map((_, i) => 14 + (i % 3)),
    apparent_temperature_max: days.map((_, i) => 28 + (i % 3)),
    apparent_temperature_min: days.map((_, i) => 13 + (i % 3)),
    sunrise: days.map((d) => `${d}T05:40`),
    sunset: days.map((d) => `${d}T18:10`),
    uv_index_max: days.map(() => 11),
    precipitation_sum: days.map((_, i) => (code >= 51 ? 3 + i : 0)),
    precipitation_probability_max: days.map((_, i) => 20 + i * 5),
    wind_speed_10m_max: days.map(() => 22),
    wind_gusts_10m_max: days.map(() => 38),
  };
  const hour = local.getUTCHours();
  const models = [
    "ecmwf_ifs",
    "ecmwf_aifs025_single",
    "gfs_seamless",
    "icon_global",
    "gem_global",
    "meteofrance_arpege_world",
  ];
  return {
    current: {
      time: iso(day0 + hour * 3600e3),
      temperature_2m: hourly.temperature_2m[hour],
      relative_humidity_2m: 55,
      apparent_temperature: 24,
      precipitation: 0,
      weather_code: code,
      cloud_cover: 40,
      wind_speed_10m: 12,
      wind_direction_10m: 120,
      wind_gusts_10m: 22,
      uv_index: 7,
      surface_pressure: 1013,
      is_day: hour >= 6 && hour < 18 ? 1 : 0,
    },
    hourly,
    daily,
    current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
    insights: {
      gdd10To30: 12.4,
      evapotranspiration: 4.2,
      dewPoint: 11,
      precipitationType: code >= 51 ? 1 : 0,
      windSpeed: 12,
      windGust: 22,
      thunderstormProbability: code >= 95 ? 60 : 5,
      heatStressIndex: 22,
      uvHealthConcern: 7,
      moonPhase: 3,
      cloudBase: 1.6,
      cloudCeiling: null,
      visibility: 24,
    },
    minutely: {
      time: Array.from({ length: 4 }, (_, i) =>
        iso(day0 + hour * 3600e3 + i * 900e3),
      ),
      precipitation: [0, 0, 0.1, 0.2],
    },
    models: models.map((model, k) => ({
      model,
      temperature_2m: hourly.temperature_2m.map(
        (t) => +(t + k * 0.3).toFixed(1),
      ),
      precipitation: hourly.precipitation.map(
        (p) => +(p * (1 + k * 0.1)).toFixed(2),
      ),
    })),
    models_available: models,
    models_time: time,
    utc_offset_seconds: offsetSeconds,
    timezone: "Africa/Harare",
    elevation: 1490,
  };
}

// ------------------------------------------------------------------ mocking
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "*",
};
const json = (route, body, headers = {}) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { ...CORS, ...headers },
    body: JSON.stringify(body),
  });
const notFound = (route) =>
  route.fulfill({
    status: 404,
    contentType: "application/json",
    headers: CORS,
    body: "{}",
  });

/** Answer every request that is not the app's own. Returns the host counts. */
export async function mockNetwork(context) {
  const calls = {};
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === BASE) return route.continue();
    calls[url.hostname] = (calls[url.hostname] ?? 0) + 1;
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          ...CORS,
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
    if (url.hostname === "weather-api.mukoko.com") {
      const p = url.pathname;
      const lat = Number(url.searchParams.get("lat")) || -17.83;
      const lon = Number(url.searchParams.get("lon")) || 31.05;
      if (p === "/v1/weather")
        return json(route, weatherPayload(lat, lon), {
          "x-weather-provider": "open-meteo:blend",
          "x-cache": "HIT",
          "x-enrichment": "none",
        });
      if (p === "/v1/air-quality")
        return json(route, {
          aqi: 52,
          level: "moderate",
          dominantPollutant: "pm2_5",
          pollutants: { pm2_5: 14, pm10: 26, o3: 60, no2: 12, so2: 4, co: 220 },
          whoGuidelines: { pm2_5: 15, pm10: 45, o3: 100, no2: 25, so2: 40 },
          todayUsAqi: 52,
          yesterdayAqi: 48,
          trend: "similar",
          source: "mock",
          fetchedAt: new Date().toISOString(),
        });
      if (p === "/v1/air-quality/grid") {
        const points = [];
        for (let i = -3; i <= 3; i++)
          for (let j = -3; j <= 3; j++)
            points.push({
              lat: lat + i * 0.1,
              lon: lon + j * 0.1,
              aqi: 40 + ((i * j + 9) % 30),
              pm2_5: 10,
            });
        return json(route, {
          available: true,
          center: { lat, lon, aqi: 52 },
          cellKm: 11,
          points,
          fetchedAt: new Date().toISOString(),
          source: "mock",
        });
      }
      if (p === "/v1/haze")
        return json(route, {
          available: true,
          level: "light",
          type: "mist",
          headline: "Light haze",
          advice: ["Mock advice"],
          visibilityKm: 9,
          pm25: 14,
          pm25Mean: 12,
          dust: 8,
          aod: 0.2,
          usAqi: 52,
          relativeHumidity: 60,
          peakTime: null,
          season: null,
          official: null,
          attribution: "mock",
          fetchedAt: new Date().toISOString(),
        });
      if (p === "/v1/reports") return json(route, { reports: [], count: 0 });
      if (
        p === "/v1/suitability" ||
        p === "/v1/activities" ||
        p === "/v1/tags" ||
        p === "/v1/ai/suggested-rules" ||
        p === "/v1/ai/prompts"
      )
        return json(route, []);
      // A device profile does not exist yet: the app creates it, then syncs.
      if (p.startsWith("/v1/devices/")) return notFound(route);
      if (p.startsWith("/v1/devices")) return json(route, { deviceId: "mock" });
      if (p === "/v1/locations" && url.searchParams.get("slug"))
        return notFound(route);
      if (p === "/v1/metar" || p === "/v1/aviation/nearest-metar")
        return json(route, { status: "unavailable", candidates: [] });
      return json(route, { available: false, reason: "mock" });
    }
    if (url.hostname === "api.maptiler.com") {
      if (url.pathname.endsWith("style.json"))
        return json(route, {
          version: 8,
          name: "mock",
          sources: {
            base: {
              type: "raster",
              tiles: ["https://api.maptiler.com/tiles/mock/{z}/{x}/{y}.png"],
              tileSize: 256,
            },
          },
          layers: [
            {
              id: "bg",
              type: "background",
              paint: { "background-color": "#cfe0cf" },
            },
            { id: "base", type: "raster", source: "base" },
          ],
        });
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: CORS,
        body: TILE,
      });
    }
    if (
      url.hostname === "weather-tiles.mukoko.com" ||
      url.hostname === "gibs.earthdata.nasa.gov"
    )
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: CORS,
        body: TILE,
      });
    // Analytics, fonts, WorkOS: not part of the app's own memory.
    return route.abort("blockedbyclient");
  });
  return calls;
}

// --------------------------------------------------------------- measuring
/** Counts every canvas that asks for a context, and which are still alive. */
const CANVAS_TRACKER = `
(() => {
  const items = [];
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = original.call(this, type, ...rest);
    if (context && !this.__tracked) {
      this.__tracked = true;
      items.push({ ref: new WeakRef(this), context: new WeakRef(context), kind: String(type) });
    }
    return context;
  };
  window.__canvasStats = () => {
    let alive = 0, connected = 0, webgl = 0, bytes = 0;
    for (const item of items) {
      const canvas = item.ref.deref();
      if (!canvas) continue;
      alive++;
      if (canvas.isConnected) connected++;
      if (/webgl/.test(item.kind)) {
        const context = item.context.deref();
        if (context && !context.isContextLost()) webgl++;
      }
      // Two buffers for WebGL (drawing + display), one for 2D.
      bytes += canvas.width * canvas.height * 4 * (/webgl/.test(item.kind) ? 2 : 1);
    }
    return { created: items.length, alive, connected, webgl, bytes };
  };
})();
`;

/** One browser, one phone-sized page, the network mocked, CDP attached. */
export async function launchMeasured(profileName = "iphone") {
  const browser = await chromium.launch({
    args: [
      "--js-flags=--expose-gc",
      "--enable-precise-memory-info",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const context = await browser.newContext({
    ...PROFILES[profileName],
    // The worker is a different process with its own cache; this measures the app.
    serviceWorkers: "block",
    locale: "en-ZW",
    timezoneId: "Africa/Harare",
  });
  await context.addInitScript(CANVAS_TRACKER);
  const calls = await mockNetwork(context);
  const page = await context.newPage();
  // Uncaught page errors, which the budget asserts there are none of. One is
  // the harness's own doing: serviceWorkers is "block", and serwist then reads
  // `registration.waiting` of a registration that never came.
  const errors = [];
  page.on("pageerror", (error) => {
    const message = String(error.message).slice(0, 160);
    if (!/reading 'waiting'/.test(message)) errors.push(message);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  return { browser, context, page, cdp, calls, errors, profile: profileName };
}

const MB = (bytes) => +(bytes / 1048576).toFixed(1);

async function readOnce(env, label) {
  const { page, cdp } = env;
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(150);
  const metrics = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
  const counters = await cdp.send("Memory.getDOMCounters");
  const canvas = await page.evaluate(() => window.__canvasStats());
  return {
    label,
    heapMB: MB(metrics.JSHeapUsedSize),
    nodes: counters.nodes,
    listeners: counters.jsEventListeners,
    canvasAlive: canvas.alive,
    canvasCreated: canvas.created,
    webglAlive: canvas.webgl,
    workers: page.workers().length,
    canvasMB: MB(canvas.bytes),
  };
}

/**
 * A reading after a forced garbage collection, taken again (up to four times,
 * 400 ms apart) until the DOM node and listener counts agree twice running: a
 * sheet that is still closing or a chart still being torn down shows up as a
 * few dozen extra listeners for a moment, which is not memory kept.
 */
export async function reading(env, label) {
  let last = await readOnce(env, label);
  for (let i = 0; i < 3; i++) {
    await sleep(400);
    const next = await readOnce(env, label);
    const settled =
      next.nodes === last.nodes && next.listeners === last.listeners;
    last = next;
    if (settled) break;
  }
  return last;
}

/** Least-squares slope of `pick(row)` over the rows, per row. */
export function slope(rows, pick) {
  const n = rows.length;
  if (n < 2) return 0;
  const ys = rows.map(pick);
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, i) => {
    num += (i - mx) * (y - my);
    den += (i - mx) ** 2;
  });
  return num / den;
}

/** The app has painted a temperature and mounted its sections. */
export const waitForPlace = (page, timeout = 30000) =>
  page.waitForFunction(
    () =>
      /\d+°/.test(document.body.innerText) &&
      !!document.querySelector("[data-lazy-section]"),
    null,
    { timeout },
  );

/**
 * The app creates its preferences on a first visit and only then reads them, so
 * saved places are written into that document and the page is reloaded. The
 * RxDB database is found by listing IndexedDB (its name carries a schema
 * version), and a seeding that did not work throws: a budget measured on a page
 * without the saved places measures the wrong page.
 */
export async function seedSavedPlaces(page, saved = SAVED_PLACES) {
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  // Let the app finish creating its preferences before they are written to.
  await page.waitForTimeout(3500);
  const seed = () =>
    page.evaluate(async (places) => {
      const names = (await indexedDB.databases()).map((d) => d.name);
      const name = names.find((n) => /^rxdb-dexie-.*--preferences$/.test(n));
      if (!name)
        return {
          ok: false,
          why: `no preferences database (found: ${names.join(", ") || "none"})`,
        };
      return new Promise((resolve) => {
        const open = indexedDB.open(name);
        open.onerror = () => resolve({ ok: false, why: `cannot open ${name}` });
        open.onsuccess = () => {
          const store = open.result
            .transaction("docs", "readwrite")
            .objectStore("docs");
          const all = store.getAll();
          all.onsuccess = () => {
            const doc = all.result[0];
            if (!doc)
              return resolve({
                ok: false,
                why: `${name} holds no preferences document`,
              });
            Object.assign(doc, {
              savedLocations: places,
              selectedActivities: [
                "maize-farming",
                "cattle-herding",
                "soccer",
                "braai",
              ],
              hasOnboarded: true,
              theme: "light",
              updatedAt: Date.now(),
            });
            store.put(doc).onsuccess = () => resolve({ ok: true });
          };
        };
      });
    }, saved);
  // The database and its document appear a moment after load (a first visit
  // creates them): try for up to 25 s, then give up with the reason.
  let seeded = await seed();
  for (let i = 0; i < 25 && !seeded.ok; i++) {
    await page.waitForTimeout(1000);
    seeded = await seed();
  }
  if (!seeded.ok)
    throw new Error(
      `seedSavedPlaces: ${seeded.why}. The app's preferences store has changed; update memory-harness.mjs.`,
    );
  await page.reload({ waitUntil: "domcontentloaded" });
  // The places lane must now offer the saved places.
  await page
    .waitForSelector(`a[href="/${saved[0]}"]`, { timeout: 20000 })
    .catch(() => {
      throw new Error(
        `seedSavedPlaces: the saved places were written but the page does not list /${saved[0]}; update memory-harness.mjs.`,
      );
    });
}

/** Click a link by its href from the page, as a plain left click. */
export const clickLink = (page, href) =>
  page.evaluate((target) => {
    const link = document.querySelector(`a[href="${target}"]`);
    if (!link) return false;
    link.click();
    return true;
  }, href);

/** Scroll the whole page down and back up so every lazy section mounts and unmounts. */
export async function scrollThrough(page, { step = 500, wait = 450 } = {}) {
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  const stops = [];
  for (let y = 0; y < height; y += step) stops.push(y);
  for (const y of [...stops, ...stops.slice().reverse()]) {
    await page.evaluate(
      (top) => window.scrollTo({ top, behavior: "instant" }),
      y,
    );
    await sleep(wait);
  }
  await sleep(2500);
}
