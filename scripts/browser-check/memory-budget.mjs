// Memory budget of the place page and its neighbours, measured in a real
// browser (issue #476).
//
//   npm run build && npx next start -p 3100 &
//   BASE=http://localhost:3100 node scripts/browser-check/memory-budget.mjs
//   PROFILE=pixel  ...   # the Android profile: the Three.js sky instead of the 2D one
//   QUICK=1        ...   # 12 place switches, 8 sheet cycles, 1 chip round (about 3 minutes)
//
// A manual check, run before a release that touches the place page or the map;
// not a CI gate (Playwright is not a dependency of this repo: put its
// node_modules on NODE_PATH). Needs no network: the app's Worker calls, the map
// tiles and everything else it asks for are answered by memory-harness.mjs. Exit code 0 is a pass, 1 a
// budget that was exceeded, 2 a crash of the check itself.
//
// What it proves: no memory is kept for a place, a sheet, a section or a map
// after the visitor has left it (growth per switch, per cycle, per round), and
// the page as a whole stays inside the budget below. What it cannot prove: how
// much a real phone allows a tab. Chromium on a desktop is a stand-in, so the
// budgets are for CHANGE (a regression shows here first), not a promise that a
// phone with this much free memory will keep the tab.
import { BASE, reporter, run } from "./harness.mjs";
import {
  clickLink,
  launchMeasured,
  reading,
  scrollThrough,
  seedSavedPlaces,
  sleep,
  slope,
  waitForPlace,
} from "./memory-harness.mjs";

const PROFILE = process.env.PROFILE === "pixel" ? "pixel" : "iphone";
const QUICK = process.env.QUICK === "1";
const SWITCHES = QUICK ? 12 : 30;
const SHEET_CYCLES = QUICK ? 8 : 20;
const CHIP_ROUNDS = QUICK ? 1 : 3;
const NAV_ROUNDS = QUICK ? 2 : 4;
/** The Android sky is Three.js, so one WebGL context is the page's own; the iPhone sky is 2D. */
const SKY_WEBGL = PROFILE === "pixel" ? 1 : 0;

/**
 * The budget. Every number is the measured value (production build, this
 * harness, desktop Chromium) with headroom for noise, so a change that makes a
 * page hold more fails here with the number it reached. Change a number only
 * with the measurement that justifies it, in the PR that changes the page.
 */
const BUDGET = {
  // /harare, loaded, idle for 15 s.
  cold: {
    heapMB: 16,
    nodes: 1700,
    canvasAlive: 3,
    canvasMB: 6,
    webglAlive: SKY_WEBGL,
  },
  // /harare after the whole page has been scrolled down and back (every lazy
  // section mounted once), and with the air quality card on screen. No WebGL
  // context but the Android sky, and no web worker: a card that cannot be
  // panned is a picture (#476). The card was a MapLibre map: 1 context, 2
  // workers and 13 MB of canvas here.
  scrolled: {
    heapMB: 18,
    nodes: 1800,
    canvasAlive: 6,
    canvasMB: 8,
    webglAlive: SKY_WEBGL,
    workers: 0,
  },
  card: {
    heapMB: 18,
    nodes: 1800,
    canvasMB: 8,
    webglAlive: SKY_WEBGL,
    workers: 0,
  },
  // Growth over place switches, measured from the 6th switch (the first lap
  // visits every place once). What remains is the engine compiling hot code
  // (about 1 MB over 25 switches, all of it code objects in a heap snapshot
  // diff); a place kept alive per switch (about 0.5 MB each) would fail this.
  switches: {
    heapGrowthMB: 2,
    nodesGrowth: 40,
    listenersGrowth: 30,
    canvasAlive: 4,
    webglAlive: SKY_WEBGL,
  },
  // Opening and closing the detail sheets, after each has been opened once.
  // A sheet that is still closing shows ~33 extra listeners for a moment even
  // in a settled reading, so the bound is above that and below 2 per cycle.
  sheets: { heapGrowthMB: 2, nodesGrowth: 40, listenersGrowth: 40 },
  // The full-screen map, every layer chip three times, the timeline playing:
  // the one place a WebGL map belongs. Its canvas is drawn at 2x at most
  // (mapPixelRatioOverride): 10 MB on a 3x phone, 23 MB before the cap.
  map: { heapMB: 18, webglAlive: 1, canvasMB: 14 },
  // Place page -> sub-route/map/list -> back, in the router, no document reload.
  navigation: {
    heapSlopeMBPerRound: 1,
    nodesGrowth: 40,
    webglAlive: SKY_WEBGL,
    // Not zero, and not a leak: once a map page has been opened MapLibre keeps
    // its one global worker pool for the rest of the session (its global
    // dispatcher holds it), so leaving /map in the router leaves exactly that
    // pool. Its size is MapLibre's own workerCount: 1 for a Chrome user agent
    // (the Android profile), up to 3 for a Safari one by core count (the iPhone
    // profile; 2 on a 4-core machine). Only a new document frees it (#476).
    workers: PROFILE === "pixel" ? 1 : 3,
  },
};

const { note, finish } = reporter();
const show = (r) =>
  `heap ${r.heapMB} MB, ${r.nodes} nodes, ${r.listeners} listeners, canvases ${r.canvasAlive} (${r.canvasMB} MB), webgl ${r.webglAlive}, workers ${r.workers}`;
const within = (name, value, limit, unit = "") =>
  note(
    `${name} <= ${limit}${unit}`,
    value <= limit,
    `${+value.toFixed(2)}${unit}`,
  );

/** The scenario's page threw nothing: an error page or a crashed section makes everything shrink and "pass". */
const noPageErrors = (env, scenario) =>
  note(
    `${scenario}: no uncaught page errors`,
    env.errors.length === 0,
    env.errors.slice(0, 3).join(" | "),
  );

async function openPlace(env) {
  await seedSavedPlaces(env.page);
  await waitForPlace(env.page);
  await sleep(3000);
}

run(async () => {
  console.log(`profile ${PROFILE}${QUICK ? " (quick)" : ""}, ${BASE}\n`);

  // 1. Cold load and 2. a full scroll --------------------------------------
  {
    const env = await launchMeasured(PROFILE);
    await openPlace(env);
    await sleep(15000);
    const cold = await reading(env, "cold");
    console.log(`cold      ${show(cold)}`);
    for (const key of [
      "heapMB",
      "nodes",
      "canvasAlive",
      "canvasMB",
      "webglAlive",
    ])
      within(`cold ${key}`, cold[key], BUDGET.cold[key]);

    await scrollThrough(env.page);
    const scrolled = await reading(env, "scrolled");
    console.log(`scrolled  ${show(scrolled)}`);
    for (const key of [
      "heapMB",
      "nodes",
      "canvasAlive",
      "canvasMB",
      "webglAlive",
      "workers",
    ])
      within(`scrolled ${key}`, scrolled[key], BUDGET.scrolled[key]);

    // The air quality card is far enough down to be unmounted again by now;
    // scroll to it so it is on screen, as a reader's phone would have it.
    const found = await env.page.evaluate(() => {
      const card = document.querySelector(
        '[data-lazy-section="air-quality-map"]',
      );
      if (!card) return false;
      window.scrollTo({
        top: card.getBoundingClientRect().top + window.scrollY - 100,
        behavior: "instant",
      });
      return true;
    });
    note("the page has an air quality card to scroll to", found);
    await sleep(3500);
    const card = await reading(env, "card");
    console.log(`card      ${show(card)}`);
    for (const key of ["heapMB", "nodes", "canvasMB", "webglAlive", "workers"])
      within(`card ${key}`, card[key], BUDGET.card[key]);
    noPageErrors(env, "cold and scrolled");
    await env.browser.close();
  }

  // 3. Place switching --------------------------------------------------
  {
    const env = await launchMeasured(PROFILE);
    await openPlace(env);
    const lap = [
      "/bulawayo",
      "/nairobi-ke",
      "/lagos-ng",
      "/cape-town-za",
      "/singapore-sg",
      "/",
    ];
    const rows = [];
    const missing = [];
    for (let i = 1; i <= SWITCHES; i++) {
      const href = lap[(i - 1) % lap.length];
      if (!(await clickLink(env.page, href))) missing.push(href);
      await sleep(2200);
      rows.push(await reading(env, `switch ${i} ${href}`));
    }
    const steady = rows.slice(5);
    const first = steady[0];
    const last = steady.at(-1);
    console.log(
      `switching ${steady.length} switches after warm-up: ${show(first)}  ->  ${show(last)}`,
    );
    note("every place link was there", missing.length === 0, missing.join(" "));
    within(
      "switch heap growth",
      last.heapMB - first.heapMB,
      BUDGET.switches.heapGrowthMB,
      " MB",
    );
    console.log(
      `          slope ${slope(steady, (r) => r.heapMB).toFixed(3)} MB/switch over ${steady.length} switches`,
    );
    within(
      "switch nodes growth",
      last.nodes - first.nodes,
      BUDGET.switches.nodesGrowth,
    );
    within(
      "switch listeners growth",
      last.listeners - first.listeners,
      BUDGET.switches.listenersGrowth,
    );
    within(
      "switch canvases alive",
      last.canvasAlive,
      BUDGET.switches.canvasAlive,
    );
    within(
      "switch webgl contexts alive",
      last.webglAlive,
      BUDGET.switches.webglAlive,
    );
    noPageErrors(env, "place switching");
    await env.browser.close();
  }

  // 4. Detail sheets ----------------------------------------------------
  {
    const env = await launchMeasured(PROFILE);
    await openPlace(env);
    const openers = await env.page.evaluate(
      () => document.querySelectorAll('button[aria-haspopup="dialog"]').length,
    );
    note(
      "the page has detail sheets to open",
      openers >= 8,
      `${openers} openers`,
    );
    const cycle = async (n) => {
      await env.page.evaluate(
        (index) =>
          document
            .querySelectorAll('button[aria-haspopup="dialog"]')
            [index]?.click(),
        n % openers,
      );
      await sleep(700);
      await env.page.keyboard.press("Escape");
      await sleep(500);
    };
    // Each sheet loads its code and wires itself up the first time it is
    // opened (about 13 listeners each, then flat): that is warm-up, not a
    // leak, so every sheet is opened once before the reading starts.
    for (let i = 0; i < openers; i++) await cycle(i);
    const start = await reading(env, "sheets start");
    for (let i = 0; i < SHEET_CYCLES; i++) await cycle(i);
    const end = await reading(env, "sheets end");
    console.log(
      `sheets    ${SHEET_CYCLES} cycles after one pass: ${show(start)}  ->  ${show(end)}`,
    );
    within(
      "sheets heap growth",
      end.heapMB - start.heapMB,
      BUDGET.sheets.heapGrowthMB,
      " MB",
    );
    within(
      "sheets nodes growth",
      end.nodes - start.nodes,
      BUDGET.sheets.nodesGrowth,
    );
    within(
      "sheets listeners growth",
      end.listeners - start.listeners,
      BUDGET.sheets.listenersGrowth,
    );
    noPageErrors(env, "detail sheets");
    await env.browser.close();
  }

  // 5. The map --------------------------------------------------------------
  {
    const env = await launchMeasured(PROFILE);
    await env.page.goto(`${BASE}/harare/map`, {
      waitUntil: "domcontentloaded",
    });
    await env.page
      .waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 })
      .catch(() => {});
    await sleep(4000);
    const chips = await env.page.evaluate(
      () => document.querySelectorAll("button[aria-pressed]").length,
    );
    note("the map has its layer chips", chips >= 5, `${chips} chips`);
    for (let round = 0; round < CHIP_ROUNDS; round++)
      for (let i = 0; i < chips; i++) {
        await env.page.evaluate(
          (n) => document.querySelectorAll("button[aria-pressed]")[n]?.click(),
          i,
        );
        await sleep(2200);
      }
    await env.page.evaluate(() => {
      const play = [...document.querySelectorAll("button")].find((b) =>
        /play/i.test(b.getAttribute("aria-label") ?? ""),
      );
      play?.click();
    });
    await sleep(15000);
    const map = await reading(env, "map");
    console.log(`map       ${show(map)}`);
    within("map heap", map.heapMB, BUDGET.map.heapMB, " MB");
    within("map webgl contexts alive", map.webglAlive, BUDGET.map.webglAlive);
    within("map canvas memory", map.canvasMB, BUDGET.map.canvasMB, " MB");
    noPageErrors(env, "the map");
    await env.browser.close();
  }

  // 6. Router navigation between pages ---------------------------------------
  {
    const env = await launchMeasured(PROFILE);
    await openPlace(env);
    const rows = [await reading(env, "navigation start")];
    const missing = [];
    for (let round = 1; round <= NAV_ROUNDS; round++) {
      for (const href of [
        "/harare/forecast",
        "/harare/atmosphere",
        "/harare/map",
        "/locations",
      ]) {
        if (!(await clickLink(env.page, href))) missing.push(href);
        await sleep(href.endsWith("map") ? 5000 : 3500);
        await env.page.evaluate(() =>
          window.scrollTo({ top: 1800, behavior: "instant" }),
        );
        await sleep(1500);
        await env.page.goBack();
        await sleep(3500);
      }
      // Back at the top, so the same sections are mounted at every reading.
      await env.page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await sleep(2500);
      rows.push(await reading(env, `navigation round ${round}`));
    }
    const steady = rows.slice(1);
    const first = steady[0];
    const last = steady.at(-1);
    console.log(
      `navigation ${NAV_ROUNDS} rounds: ${show(first)}  ->  ${show(last)}`,
    );
    note("every link was there", missing.length === 0, missing.join(" "));
    within(
      "navigation heap slope",
      slope(steady, (r) => r.heapMB),
      BUDGET.navigation.heapSlopeMBPerRound,
      " MB/round",
    );
    within(
      "navigation nodes growth",
      last.nodes - first.nodes,
      BUDGET.navigation.nodesGrowth,
    );
    within(
      "navigation workers after the map",
      last.workers,
      BUDGET.navigation.workers,
    );
    within(
      "navigation webgl contexts alive",
      last.webglAlive,
      BUDGET.navigation.webglAlive,
    );
    noPageErrors(env, "router navigation");
    await env.browser.close();
  }

  finish();
});
