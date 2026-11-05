// The account avatar and My Location swapped places (owner, 2026-11-05, #525):
// the avatar is the first slot of the phone bottom bar and its menu opens
// UPWARD; My Location is the round arrow link in the hero's top group and in
// the header's pill.
//
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/account-menu-bar.mjs
//
// What only a browser can show: the menu's panel hangs from the bar (the bar
// has a backdrop-filter, so a `fixed` panel would not be viewport-anchored),
// so at 393x852 and 360x740 it is fully on screen, its left edge is the bar's,
// its bottom edge is a gap above the bar and it is the top layer; Escape and a
// tap outside close it and Escape gives focus back; My Location sits in the
// hero group on a place page and in the header pill on a page with no hero
// (/locations), as a 49px link that goes to `/` and is current there; and the
// header's account icon is not drawn on a phone. Desktop at 1280px is
// unchanged: no phone group, no bar, no My Location icon.
import { BASE, SHOTS, chromium, proxyApi, reporter, run } from "./harness.mjs";

const { note, finish } = reporter();
const TOUCH = 49; // --touch-target-min
const ACCOUNT = '[data-slot="mzizi-bottom-nav"] [data-slot="account-menu"]';
const SIZES = [
  { name: "393x852", width: 393, height: 852 },
  { name: "360x740", width: 360, height: 740 },
];

const rect = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      right: r.right,
      bottom: r.bottom,
    };
  }, selector);

const isOpen = (page) =>
  page.evaluate((sel) => document.querySelector(sel).open, ACCOUNT);

run(async () => {
  const browser = await chromium.launch();
  for (const size of SIZES) {
    const tag = size.name;
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: true,
      isMobile: true,
    });
    await proxyApi(context);
    const page = await context.newPage();

    // A place page: the hero group and the bar.
    await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.hadeda a[aria-label="My Location"]', {
      timeout: 60000,
    });
    await page.waitForSelector(`${ACCOUNT} summary`, { timeout: 20000 });
    await page.waitForTimeout(1500);

    const group = await page.evaluate(() => {
      const g = document.querySelector(".hadeda");
      return {
        controls: g.querySelectorAll("a, button").length,
        menu: g.querySelectorAll("details").length,
      };
    });
    note(
      `[${tag}] the hero group holds Share and My Location, no account menu`,
      group.controls === 2 && group.menu === 0,
      JSON.stringify(group),
    );
    const here = await rect(page, '.hadeda a[aria-label="My Location"]');
    note(
      `[${tag}] My Location is a ${TOUCH}px round link`,
      Math.abs(here.w - TOUCH) < 0.6 && Math.abs(here.h - TOUCH) < 0.6,
      `${here.w}x${here.h}`,
    );

    const trigger = await rect(page, `${ACCOUNT} summary`);
    note(
      `[${tag}] the account trigger is a ${TOUCH}px target in the bar`,
      Math.abs(trigger.w - TOUCH) < 0.6 && Math.abs(trigger.h - TOUCH) < 0.6,
      `${trigger.w}x${trigger.h}`,
    );
    const order = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-slot="mzizi-bottom-nav"] > a, [data-slot="mzizi-bottom-nav"] summary, [data-slot="mzizi-bottom-nav"] [aria-label="Places"] a',
        ),
      ].map((el) =>
        el.tagName === "SUMMARY"
          ? "ACCOUNT"
          : (el.getAttribute("aria-label") ?? el.textContent.trim()),
      ),
    );
    note(
      `[${tag}] the bar reads Map, the account control, the places, Locations`,
      /map/i.test(order[0]) &&
        order[1] === "ACCOUNT" &&
        /locations/i.test(order.at(-1)),
      order.join(" | "),
    );

    // Open it: upward, on screen, against the bar.
    const bar = await rect(page, '[data-slot="mzizi-bottom-nav"]');
    await page.tap(`${ACCOUNT} summary`);
    await page.waitForTimeout(500);
    const panel = await rect(
      page,
      `${ACCOUNT} [data-slot="account-menu-panel"]`,
    );
    note(`[${tag}] the menu opens`, await isOpen(page));
    note(
      `[${tag}] the panel is fully on screen`,
      panel.x >= 0 && panel.right <= size.width && panel.y >= 0,
      `x ${panel.x.toFixed(1)}..${panel.right.toFixed(1)} of ${size.width}, y ${panel.y.toFixed(1)}..${panel.bottom.toFixed(1)}`,
    );
    note(
      `[${tag}] the panel sits above the bar, a gap clear of it (7px or more)`,
      panel.bottom <= bar.y - 7 + 1.5 && panel.bottom >= bar.y - 12,
      `panel bottom ${panel.bottom.toFixed(1)}, bar top ${bar.y.toFixed(1)}`,
    );
    note(
      `[${tag}] the panel's left edge is the bar's, and it is not wider than the bar`,
      Math.abs(panel.x - bar.x) <= 1.5 && panel.w <= bar.w + 0.5,
      `${panel.x.toFixed(1)} vs ${bar.x.toFixed(1)}, ${panel.w} in ${bar.w}`,
    );
    const onTop = await page.evaluate(
      ([x, y]) =>
        !!document
          .elementFromPoint(x, y)
          ?.closest('[data-slot="account-menu-panel"]'),
      [panel.x + panel.w / 2, panel.y + 30],
    );
    note(`[${tag}] the panel is the top layer`, onTop);
    await page.screenshot({ path: `${SHOTS}/account-menu-bar-${tag}.png` });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    const afterEscape = await page.evaluate(
      (sel) => ({
        open: document.querySelector(sel).open,
        focused: document.activeElement?.tagName,
      }),
      ACCOUNT,
    );
    note(
      `[${tag}] Escape closes the menu and gives focus back to the trigger`,
      !afterEscape.open && afterEscape.focused === "SUMMARY",
      JSON.stringify(afterEscape),
    );
    await page.tap(`${ACCOUNT} summary`);
    await page.waitForTimeout(300);
    // Above the panel at every phone height (the panel is 288 wide and tall).
    await page.touchscreen.tap(size.width / 2, 40);
    await page.waitForTimeout(300);
    note(`[${tag}] a tap outside closes the menu`, !(await isOpen(page)));

    // My Location: a tap goes to `/`, where it is the current page.
    await page.tap('.hadeda a[aria-label="My Location"]');
    await page.waitForURL((url) => new URL(url).pathname === "/", {
      timeout: 60000,
    });
    await page
      .waitForSelector(
        '.hadeda a[aria-label="My Location"][aria-current="page"]',
        { timeout: 30000 },
      )
      .then(
        () =>
          note(
            `[${tag}] a tap on My Location goes to / and marks it current`,
            true,
          ),
        () =>
          note(
            `[${tag}] a tap on My Location goes to / and marks it current`,
            false,
          ),
      );

    // A page with no hero: My Location is in the header's pill, the account
    // icon is not drawn on a phone, the bar still has the account control.
    await page.goto(`${BASE}/locations`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-site-header]", { timeout: 30000 });
    await page.waitForTimeout(1500);
    const pill = await page.evaluate(() => {
      const visible = (el) => el.getClientRects().length > 0;
      return [
        ...document.querySelectorAll(
          '[data-site-header] [role="toolbar"] a, [data-site-header] [role="toolbar"] button',
        ),
      ]
        .filter(visible)
        .map((el) => ({
          label: el.getAttribute("aria-label"),
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        }));
    });
    note(
      `[${tag}] /locations: the header pill is My Location and Notifications, ${TOUCH}px each`,
      pill.length === 2 &&
        pill[0].label === "My Location" &&
        /Notifications/.test(pill[1].label ?? "") &&
        pill.every((p) => p.w === TOUCH && p.h === TOUCH),
      JSON.stringify(pill),
    );
    note(
      `[${tag}] /locations: the bar keeps the account control`,
      !!(await rect(page, `${ACCOUNT} summary`)),
    );
    await page.screenshot({
      path: `${SHOTS}/account-menu-bar-locations-${tag}.png`,
    });
    await context.close();
  }

  // Desktop is unchanged.
  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await proxyApi(desktop);
  const wide = await desktop.newPage();
  await wide.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await wide.waitForSelector("#current-conditions-heading", { timeout: 60000 });
  await wide.waitForTimeout(1500);
  const d = await wide.evaluate(() => {
    const visible = (el) => !!el && el.getClientRects().length > 0;
    return {
      group: visible(document.querySelector(".hadeda")),
      bar: visible(document.querySelector('[data-slot="mzizi-bottom-nav"]')),
      myLocation: [
        ...document.querySelectorAll('a[aria-label="My Location"]'),
      ].some(visible),
      account: [
        ...document.querySelectorAll(
          '[data-site-header] a[aria-label="Sign in"], [data-site-header] a[href="/profile"]',
        ),
      ].some(visible),
    };
  });
  note(
    "[1280] desktop: no phone group, no bar, no My Location icon; the header's account icon is shown",
    !d.group && !d.bar && !d.myLocation && d.account,
    JSON.stringify(d),
  );
  await desktop.close();

  await browser.close();
  finish();
});
