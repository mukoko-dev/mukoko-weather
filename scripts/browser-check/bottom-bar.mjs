// The phone bottom bar (owner, 2026-11-11): Map is the one pinned item at the
// start, My Location is the lane's first chip (the second control from the
// left), the places scroll after it, and the account avatar is the far right.
// Locations is not in the bar (it is the list link at the top right).
// (2026-11-05, from a screen recording: pinned items are ONE width, a preset,
// not the width of their own labels.)
//
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/bottom-bar.mjs
//
// What only a browser can show: Map's label fits whole inside its item (not
// cut, not overflowing) at several phone widths, the lane keeps a usable
// width, the items stay inside the bar, My Location comes right after Map and
// the account trigger is the last control at the bar's right edge, below 360px
// (label screen-reader-only) Map is one touch target wide, and the places lane
// moves sideways only (owner, 2026-11-05: "movable up and down as well, it
// should only move left and right"). Screenshots go to SHOTS.
import { join } from "node:path";
import { BASE, SHOTS, chromium, proxyApi, reporter, run } from "./harness.mjs";

const { note, finish } = reporter();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOUCH_TARGET_PX = 49; // --touch-target-min
const LANE_MIN_PX = 110; // My Location, the account control and part of a chip

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
    const home = nav.querySelector('a[aria-label="My Location"]');
    const account = nav.querySelector('[data-slot="account-menu"] summary');
    const homeBox = home?.getBoundingClientRect();
    const accountBox = account?.getBoundingClientRect();
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
      homeLeft: homeBox ? homeBox.left : null,
      accountRight: accountBox ? accountBox.right : null,
      hasLocationsLink: !!nav.querySelector('a[href="/locations"]'),
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
      if (!m || m.items.length !== 1) {
        note(`${tag}: the bar has one pinned item`, false, JSON.stringify(m));
        await context.close();
        continue;
      }
      const [map] = m.items;
      const compact = size.width < 360;
      if (compact) {
        note(
          `${tag}: Map's label is screen-reader-only and the item is one touch target wide`,
          !map.labelVisible && Math.abs(map.width - TOUCH_TARGET_PX) < 0.5,
          `width ${map.width.toFixed(1)}px`,
        );
      } else {
        note(
          `${tag}: Map's label is shown whole (not cut)`,
          map.labelVisible && !map.cut,
          `Map label ${map.labelWidth.toFixed(1)}px in ${map.width.toFixed(1)}px`,
        );
      }
      note(
        `${tag}: Map sits inside the bar and the lane is at least ${LANE_MIN_PX}px`,
        map.left >= m.nav.left && m.lane >= LANE_MIN_PX,
        `lane ${m.lane.toFixed(1)}px`,
      );
      note(
        `${tag}: My Location follows Map, the account trigger ends the bar, no Locations link in it`,
        m.homeLeft !== null &&
          m.homeLeft >= map.right &&
          m.accountRight !== null &&
          m.nav.right - m.accountRight >= 0 &&
          m.nav.right - m.accountRight < 24 &&
          !m.hasLocationsLink,
        `Map right ${map.right.toFixed(1)}, My Location left ${m.homeLeft?.toFixed(1)}, account right ${m.accountRight?.toFixed(1)} of bar ${m.nav.right.toFixed(1)}`,
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
