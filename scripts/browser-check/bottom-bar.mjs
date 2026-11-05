// The phone bottom bar's pinned items (owner, 2026-11-05, from a screen
// recording): Map and Locations must be ONE width, a preset, not the width of
// their own labels (Map was 53pt and Locations 85pt).
//
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/bottom-bar.mjs
//
// What only a browser can show: the two pinned items measure the same at
// several phone widths, the longest label ("Locations") fits whole inside its
// item (not cut, not overflowing), the lane keeps a usable width, the items
// stay inside the bar, and below 360px (labels screen-reader-only) both are
// still equal and one touch target wide, and the places lane moves sideways
// only (owner, 2026-11-05: "movable up and down as well, it should only move
// left and right"). Screenshots go to SHOTS.
import { join } from "node:path";
import { BASE, SHOTS, chromium, proxyApi, reporter, run } from "./harness.mjs";

const { note, finish } = reporter();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOUCH_TARGET_PX = 49; // --touch-target-min
const LANE_MIN_PX = 110; // My Location and part of one more chip

const WIDTHS = [
  { name: "iphone-se", width: 375, height: 667 },
  { name: "iphone-15-pro", width: 393, height: 852 },
  { name: "iphone-pro-max", width: 430, height: 932 },
  { name: "small", width: 340, height: 640 },
];

// Try to scroll the lane's scroller up and down, the way a finger drag would
// when the content is taller than the box. A lane that only moves sideways
// keeps scrollTop at 0 whatever is asked of it.
const probeVertical = (page) =>
  page.evaluate(() => {
    const lane = document.querySelector('[data-slot="mzizi-bottom-nav-lane"]');
    const scroller = lane?.querySelector(".sanderling");
    if (!scroller) return null;
    const style = getComputedStyle(scroller);
    const before = scroller.scrollTop;
    scroller.scrollTop = 40;
    const afterDown = scroller.scrollTop;
    scroller.scrollTop = before;
    return {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      overflowsVertically: scroller.scrollHeight > scroller.clientHeight + 0.5,
      scrollable: afterDown !== before,
    };
  });

const measure = (page) =>
  page.evaluate(() => {
    const nav = document.querySelector('[data-slot="mzizi-bottom-nav"]');
    if (!nav) return null;
    const pinned = [...nav.querySelectorAll(":scope > a")];
    const lane = nav.querySelector('[data-slot="mzizi-bottom-nav-lane"]');
    const navBox = nav.getBoundingClientRect();
    const items = pinned.map((a) => {
      const box = a.getBoundingClientRect();
      const label = a.querySelector("span");
      const labelStyle = label ? getComputedStyle(label) : null;
      return {
        text: label?.textContent ?? "",
        width: box.width,
        left: box.left,
        right: box.right,
        labelVisible:
          label && labelStyle
            ? labelStyle.position !== "absolute" && label.clientWidth > 0
            : false,
        // The label holds whole: not cut (an ellipsis would hide text) and
        // not wider than the room inside the button.
        cut: label ? label.scrollWidth > label.clientWidth + 0.5 : false,
        labelWidth: label ? label.getBoundingClientRect().width : 0,
      };
    });
    return {
      items,
      lane: lane ? lane.getBoundingClientRect().width : 0,
      nav: { left: navBox.left, right: navBox.right, width: navBox.width },
      viewport: window.innerWidth,
    };
  });

run(async () => {
  const browser = await chromium.launch();
  try {
    for (const size of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });
      await proxyApi(context);
      const page = await context.newPage();
      await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-slot="mzizi-bottom-nav"]', {
        timeout: 20000,
      });
      await sleep(1500); // fonts, the lane's first layout
      const m = await measure(page);
      const tag = `${size.name} ${size.width}px`;
      if (!m || m.items.length !== 2) {
        note(`${tag}: the bar has two pinned items`, false, JSON.stringify(m));
        await context.close();
        continue;
      }
      const [map, locations] = m.items;
      note(
        `${tag}: Map and Locations are the same width`,
        Math.abs(map.width - locations.width) < 0.5,
        `Map ${map.width.toFixed(1)}px, Locations ${locations.width.toFixed(1)}px`,
      );
      const compact = size.width < 360;
      if (compact) {
        note(
          `${tag}: labels are screen-reader-only and the items are one touch target wide`,
          !map.labelVisible &&
            !locations.labelVisible &&
            Math.abs(map.width - TOUCH_TARGET_PX) < 0.5,
          `width ${map.width.toFixed(1)}px`,
        );
      } else {
        note(
          `${tag}: both labels are shown whole (not cut)`,
          map.labelVisible &&
            locations.labelVisible &&
            !map.cut &&
            !locations.cut,
          `Locations label ${locations.labelWidth.toFixed(1)}px in ${locations.width.toFixed(1)}px`,
        );
      }
      note(
        `${tag}: the items sit inside the bar and the lane is at least ${LANE_MIN_PX}px`,
        map.left >= m.nav.left &&
          locations.right <= m.nav.right &&
          m.lane >= (compact ? LANE_MIN_PX + 30 : LANE_MIN_PX),
        `lane ${m.lane.toFixed(1)}px`,
      );
      const v = await probeVertical(page);
      note(
        `${tag}: the places lane scrolls sideways only`,
        v !== null &&
          v.overflowX !== "visible" &&
          v.overflowY === "hidden" &&
          !v.overflowsVertically &&
          !v.scrollable,
        v
          ? `overflow ${v.overflowX}/${v.overflowY}, taller than its box: ${v.overflowsVertically}, moved by scrollTop: ${v.scrollable}`
          : "no places scroller in the lane",
      );
      await page.screenshot({
        path: join(SHOTS, `bottom-bar-${size.name}.png`),
        clip: {
          x: 0,
          y: Math.max(0, size.height - 130),
          width: size.width,
          height: 130,
        },
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  finish();
});
