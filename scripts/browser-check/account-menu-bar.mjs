// The phone bar's order (owner, 2026-11-11): Map, My Location (the lane's first
// chip, second from the left), the places, and the account avatar at the far
// right, whose menu opens UPWARD. Locations is the round list link, the third
// control of the Quick actions group at the top right (see quick-actions.mjs);
// it is not in the bar. (2026-11-05, #525 had swapped the avatar and My
// Location.)
//
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/account-menu-bar.mjs
//
// What only a browser can show: the menu's panel hangs from the bar (the bar
// has a backdrop-filter, so a `fixed` panel would not be viewport-anchored),
// so at 393x852 and 360x740 it is fully on screen, its right edge is the bar's,
// its bottom edge is a gap above the bar and it is the top layer; Escape and a
// tap outside close it and Escape gives focus back; Locations is a 49px link
// in the group, on a place page and on a page with no hero (/locations), that
// goes to /locations and is current there; My Location is a bar chip that goes
// to `/` and is current there; and the header's account icon is not drawn on
// a phone. Desktop at 1280px: the group has Locations too, no bar, and the
// account icon is the group's last control.
import { BASE, SHOTS, chromium, proxyApi, reporter, run } from "./harness.mjs";

const { note, finish } = reporter();
const TOUCH = 49; // --touch-target-min
const ACCOUNT = '[data-slot="mzizi-bottom-nav"] [data-slot="account-menu"]';
const LOCATIONS = 'a[aria-label="All locations"]';
const HOME_CHIP = '[data-slot="mzizi-bottom-nav"] a[aria-label="My Location"]';
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
    await page.waitForSelector(`.hadeda ${LOCATIONS}`, { timeout: 60000 });
    await page.waitForSelector(`${ACCOUNT} summary`, { timeout: 20000 });
    // The page is hydrated once the real hero has replaced the skeleton (a
    // tap before that opens the native <details> without its Escape handler).
    await page.waitForSelector("[data-sky-hero]:not([data-skeleton])", {
      timeout: 60000,
    });
    await page.waitForTimeout(1500);

    const group = await page.evaluate(() => {
      const g = document.querySelector(".hadeda");
      const visible = (el) => el.getClientRects().length > 0;
      return {
        controls: [...g.querySelectorAll("a, button")].filter(visible).length,
        menu: g.querySelectorAll("details").length,
      };
    });
    note(
      `[${tag}] the group holds Share, Notifications and Locations, no account menu`,
      group.controls === 3 && group.menu === 0,
      JSON.stringify(group),
    );
    const here = await rect(page, `.hadeda ${LOCATIONS}`);
    note(
      `[${tag}] Locations is a ${TOUCH}px round link`,
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
      `[${tag}] the bar reads Map, My Location, the places, the account control`,
      /map/i.test(order[0]) &&
        order[1] === "My Location" &&
        order.at(-1) === "ACCOUNT" &&
        !order.some((o) => /locations/i.test(o) && o !== "My Location"),
      order.join(" | "),
    );
    const barBox = await rect(page, '[data-slot="mzizi-bottom-nav"]');
    note(
      `[${tag}] the account trigger is the far right of the bar (inside its padding)`,
      barBox.right - trigger.right >= 0 && barBox.right - trigger.right < 24,
      `trigger right ${trigger.right.toFixed(1)}, bar right ${barBox.right.toFixed(1)}`,
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
      `[${tag}] the panel's right edge is the bar's, and it is not wider than the bar`,
      Math.abs(panel.right - bar.right) <= 1.5 && panel.w <= bar.w + 0.5,
      `${panel.right.toFixed(1)} vs ${bar.right.toFixed(1)}, ${panel.w} in ${bar.w}`,
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

    // Locations: a tap goes to /locations, where it is the current page.
    await page.tap(`.hadeda ${LOCATIONS}`);
    await page.waitForURL((url) => new URL(url).pathname === "/locations", {
      timeout: 60000,
    });
    await page
      .waitForSelector(`${LOCATIONS}[aria-current="page"]`, { timeout: 30000 })
      .then(
        () =>
          note(
            `[${tag}] a tap on Locations goes to /locations and marks it current`,
            true,
          ),
        () =>
          note(
            `[${tag}] a tap on Locations goes to /locations and marks it current`,
            false,
          ),
      );

    // My Location (the bar's second control): a tap goes to `/`, where it is
    // the current page.
    await page.tap(HOME_CHIP);
    await page.waitForURL((url) => new URL(url).pathname === "/", {
      timeout: 60000,
    });
    await page
      .waitForSelector(`${HOME_CHIP}[aria-current="page"]`, { timeout: 30000 })
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

    // A page with no hero: the same group, the account icon is not drawn on a
    // phone, the bar still has the account control.
    await page.goto(`${BASE}/locations`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".hadeda", { timeout: 30000 });
    await page.waitForTimeout(1500);
    const pill = await page.evaluate(() => {
      const visible = (el) => el.getClientRects().length > 0;
      return [...document.querySelectorAll(".hadeda a, .hadeda button")]
        .filter(visible)
        .map((el) => ({
          label: el.getAttribute("aria-label"),
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        }));
    });
    note(
      `[${tag}] /locations: the group is Share, Notifications and Locations, ${TOUCH}px each`,
      pill.length === 3 &&
        pill[0].label === "Share this page" &&
        /Notifications/.test(pill[1].label ?? "") &&
        pill[2].label === "All locations" &&
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

  // Desktop: the group has Locations too (consistent across the app), the
  // account icon is its last control, and there is no bottom bar.
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
      locations: [
        ...document.querySelectorAll('.hadeda a[aria-label="All locations"]'),
      ].some(visible),
      account: [
        ...document.querySelectorAll(
          '.hadeda a[aria-label="Sign in"], .hadeda a[href="/profile"]',
        ),
      ].some(visible),
    };
  });
  note(
    "[1280] desktop: the group has Locations and the account icon, and there is no bottom bar",
    d.group && !d.bar && d.locations && d.account,
    JSON.stringify(d),
  );
  await desktop.close();

  await browser.close();
  finish();
});
