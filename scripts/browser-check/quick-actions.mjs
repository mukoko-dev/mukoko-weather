// The Quick actions group (owner, 2026-11-11: "For the icon group on the top
// right we need to keep it consistent across the entire app, so 3 icons,
// share, notifications, locations based on the background the group is clear
// or has a solid color"): Share, Notifications, Locations, the same three on
// every page, in ONE round pill fixed to the top right, mounted once.
//
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/quick-actions.mjs
//
// What only a browser can show:
//   - exactly one group, and one notifications centre when it is open, on a
//     place page, plain pages (/locations, /releases), the map and an UNKNOWN
//     place's map route (the not-found page draws its own header, which brings
//     the group), at 393x852 and 1280x800, with the same three controls in the
//     same order, each 49px; none in /embed/widget or on /display;
//   - the look follows the background: clear (no fill, no border, no shadow,
//     icons in the sky foreground) over bare sky at rest at the top of a place
//     page (at 360, 393 and 430 wide, with a breadcrumb of one, two or three
//     lines), solid once the hero's first line of content reaches the group,
//     back to clear at the top, solid on every other page and on the map, in
//     light and in dark, cross-faded over 200ms and not at all under reduced
//     motion; the group is clear over the loading skeleton too, and does not
//     change when the real hero replaces it;
//   - it stays where it is while the page scrolls (an ancestor with a
//     transform, filter or backdrop-filter would take it with the page), at the
//     float grid's corner on a phone, on the header row's grid from `sm`
//     (also with real 15px scrollbars; a modal open does not move it), in the
//     same place on every page;
//   - the header row at 360 to 1920px: three controls up to 767px, four (the
//     account icon) from 768px, five (Map) from 1024px, and at every width
//     nothing under the group, the brand clear of the nav, nothing past the
//     screen;
//   - the map's bottom sheet, at its tallest with the capacity note showing,
//     stops under the layers and locate controls on 375x667 and 360x640
//     (skipped on a build without the capacity note);
//   - the bell opens the notifications centre on a phone place page, anchored
//     under the bell on desktop;
//   - Share shares the place (its address, title and sentence) on a place page
//     and the page (its address without a query string or fragment, and its
//     title) on any other, and says "Link copied" where the browser has no
//     share sheet;
//   - desktop keeps the account icon and Map after the three, in the same pill.
//
// Phone: no weather tiles are requested (the tiles host is answered by a 1x1
// image), and the public weather API is only read.
import {
  BASE,
  SHOTS,
  chromium,
  proxyApi,
  reporter,
  run,
  stubTiles,
} from "./harness.mjs";

const { note, finish } = reporter();
const TOUCH = 49; // --touch-target-min
const PHONE = { width: 393, height: 852 };
const DESKTOP = { width: 1280, height: 800 };
const GROUP = "[data-quick-actions]";
const THREE = [
  /^Share (weather for .+|this page)$/,
  /^Notifications/,
  /^All locations$/,
];

/** Where an element is, in CSS pixels. */
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

/** The group's controls that are drawn, in order, with their size. */
const controls = (page) =>
  page.evaluate((sel) => {
    const visible = (el) => el.getClientRects().length > 0;
    return [...document.querySelectorAll(`${sel} a, ${sel} button`)]
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const svg = el.querySelector("svg");
        return {
          label: el.getAttribute("aria-label"),
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
          icon: svg ? Math.round(svg.getBoundingClientRect().width) : null,
        };
      });
  }, GROUP);

/** How the group looks right now, from the browser's own computed style. */
const look = (page) =>
  page.evaluate((sel) => {
    const g = document.querySelector(sel);
    const cs = getComputedStyle(g);
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;visibility:hidden;background:var(--color-primary);color:var(--color-primary-foreground)";
    document.body.append(probe);
    const primary = getComputedStyle(probe).backgroundColor;
    const onPrimary = getComputedStyle(probe).color;
    probe.remove();
    const icon = g.querySelector("svg");
    return {
      tone: g.dataset.tone,
      past: g.hasAttribute("data-past-sky"),
      bg: cs.backgroundColor,
      ink: getComputedStyle(icon).color,
      border: cs.borderTopWidth,
      shadow: cs.boxShadow,
      primary,
      onPrimary,
      position: cs.position,
      backdrop: cs.backdropFilter,
      duration: cs.transitionDuration,
    };
  }, GROUP);

const CLEAR_BG = "rgba(0, 0, 0, 0)";
const WHITE = "rgb(255, 255, 255)";
const isClear = (l) =>
  l.bg === CLEAR_BG &&
  l.border === "0px" &&
  l.shadow === "none" &&
  l.ink === WHITE;
const isSolid = (l) => l.bg === l.primary && l.ink === l.onPrimary;
const lookText = (l) =>
  `bg ${l.bg}, ink ${l.ink}, border ${l.border}, shadow ${l.shadow === "none" ? "none" : "yes"}`;

/** A real hero (not the skeleton) is on the page and the observer has answered. */
async function placeReady(page) {
  await page.waitForSelector("[data-sky-hero]:not([data-skeleton])", {
    timeout: 120000,
  });
  await page.waitForSelector(GROUP, { timeout: 30000 });
  await page.waitForTimeout(1500);
}

const scrollTo = async (page, y) => {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  // The observer answers, then the fill cross-fades (200ms).
  await page.waitForTimeout(700);
};

/**
 * React has attached its handlers to the control (a tap before that does
 * nothing): it puts its props on the DOM node when it hydrates.
 */
const hydrated = (page, selector) =>
  page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return (
        !!el && Object.keys(el).some((key) => key.startsWith("__reactProps"))
      );
    },
    selector,
    { timeout: 60000 },
  );

/**
 * Stub the share sheet (records what it was given in `window.__shared`) or
 * remove it (the clipboard fallback). The script is serialised into the page,
 * so what it needs is passed as its argument, not closed over.
 */
const stubShare = (target, withSheet) =>
  target.addInitScript((sheet) => {
    window.__shared = [];
    if (sheet) {
      navigator.share = (data) => {
        window.__shared.push(data);
        return Promise.resolve();
      };
    } else {
      Object.defineProperty(navigator, "share", {
        value: undefined,
        configurable: true,
      });
    }
  }, withSheet);

run(async () => {
  const browser = await chromium.launch();

  // ---------------------------------------------------------------- phone
  const phone = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
  });
  await proxyApi(phone);
  await stubTiles(phone);
  const page = await phone.newPage();
  await stubShare(page, true);

  await page.goto(`${BASE}/harare`, { waitUntil: "commit", timeout: 120000 });
  await placeReady(page);

  const count = await page.evaluate(
    (sel) => ({
      groups: document.querySelectorAll(sel).length,
      toolbars: document.querySelectorAll(
        '[role="toolbar"][aria-label="Quick actions"]',
      ).length,
      bells: document.querySelectorAll("[data-notifications-trigger]").length,
    }),
    GROUP,
  );
  note(
    "[phone /harare] exactly one group, one toolbar named Quick actions, one bell",
    count.groups === 1 && count.toolbars === 1 && count.bells === 1,
    JSON.stringify(count),
  );

  const three = await controls(page);
  note(
    "[phone /harare] Share, Notifications, Locations, in that order, and nothing else",
    three.length === 3 && THREE.every((re, i) => re.test(three[i].label ?? "")),
    three.map((c) => c.label).join(" | "),
  );
  note(
    `[phone /harare] each control is ${TOUCH}px and each icon 20px`,
    three.every((c) => c.w === TOUCH && c.h === TOUCH && c.icon === 20),
    JSON.stringify(three.map((c) => `${c.w}x${c.h}/${c.icon}`)),
  );

  const topLook = await look(page);
  note(
    "[phone /harare] at the top over the sky the group is clear: no fill, no border, no shadow, icons in the sky foreground",
    isClear(topLook) && topLook.tone === "auto" && !topLook.past,
    lookText(topLook),
  );
  note(
    "[phone /harare] the group is position: fixed and has no backdrop-filter of its own",
    topLook.position === "fixed" && topLook.backdrop === "none",
    `${topLook.position}, backdrop ${topLook.backdrop}`,
  );
  const topBox = await rect(page, GROUP);
  const row = await rect(page, "[data-sky-hero] > div");
  note(
    "[phone /harare] at the top of the page the group is level with the hero's top row",
    Math.abs(topBox.y - row.y) <= 1,
    `group y ${topBox.y.toFixed(1)}, row y ${row.y.toFixed(1)}`,
  );
  note(
    "[phone /harare] the group is at the float grid's corner: 16px from the top and the right",
    Math.abs(topBox.y - 16) <= 0.6 &&
      Math.abs(PHONE.width - topBox.right - 16) <= 0.6,
    `top ${topBox.y}, right gap ${(PHONE.width - topBox.right).toFixed(1)}`,
  );
  const crumb = await rect(page, "[data-sky-hero] [data-breadcrumb]");
  note(
    "[phone /harare] the breadcrumb leaves room for the three controls (they do not overlap)",
    crumb.right <= topBox.x - 7 + 0.5,
    `breadcrumb right ${crumb.right.toFixed(1)}, group left ${topBox.x.toFixed(1)}`,
  );
  await page.screenshot({ path: `${SHOTS}/quick-actions-phone-place-top.png` });

  // Scroll: solid as soon as the hero's first line of content reaches the
  // group (the place name under it would read as neither), fixed, and clear
  // again at the top.
  await scrollTo(page, 160);
  const nearTop = await look(page);
  note(
    "[phone /harare] scrolled until the hero's first line has reached the group: it turns solid (the brand pill)",
    isSolid(nearTop) && nearTop.past,
    lookText(nearTop),
  );
  await page.screenshot({
    path: `${SHOTS}/quick-actions-phone-place-scrolled.png`,
  });
  const moved = [];
  for (const y of [300, 1200, 4000]) {
    await scrollTo(page, y);
    const r = await rect(page, GROUP);
    moved.push(Math.abs(r.y - topBox.y) + Math.abs(r.x - topBox.x));
  }
  const farLook = await look(page);
  note(
    "[phone /harare] scrolled past the sky, over the cards and charts, the group is solid and has not moved",
    isSolid(farLook) && moved.every((d) => d < 0.5),
    `${lookText(farLook)}; moved ${moved.map((d) => d.toFixed(1)).join(", ")} px`,
  );
  await page.screenshot({
    path: `${SHOTS}/quick-actions-phone-place-cards.png`,
  });
  await scrollTo(page, 0);
  const backLook = await look(page);
  note(
    "[phone /harare] back at the top the group is clear again",
    isClear(backLook),
    lookText(backLook),
  );

  // Dark: the sky foreground is white on every sky; the pill is the dark primary.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(500);
  const darkClear = await look(page);
  await scrollTo(page, 1200);
  const darkSolid = await look(page);
  note(
    "[phone /harare, dark] clear over the sky in white; solid, the dark primary with its own foreground, over the cards",
    isClear(darkClear) && isSolid(darkSolid) && darkSolid.ink !== WHITE,
    `clear: ${lookText(darkClear)}; solid: ${lookText(darkSolid)}`,
  );
  await page.screenshot({
    path: `${SHOTS}/quick-actions-phone-place-dark.png`,
  });
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
  });
  await scrollTo(page, 0);

  // Motion: a 200ms cross-fade, none under reduced motion.
  note(
    "[phone /harare] the fill and the icons cross-fade over 200ms",
    topLook.duration.split(",").every((d) => d.trim() === "0.2s"),
    topLook.duration,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await look(page);
  note(
    "[phone /harare] under reduced motion there is no transition",
    // The global reduced-motion rule makes every transition 0.01ms.
    reduced.duration.split(",").every((d) => parseFloat(d) <= 0.001),
    reduced.duration,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Notifications reachable from the top of a place page, one centre only.
  await page.tap("[data-notifications-trigger]");
  await page.waitForSelector('[role="dialog"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  const open = await page.evaluate(() => ({
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
      (d) =>
        d.getAttribute("aria-label") ??
        d.querySelector("h2")?.textContent?.trim(),
    ),
    groups: document.querySelectorAll("[data-quick-actions]").length,
    bells: document.querySelectorAll("[data-notifications-trigger]").length,
    expanded: document
      .querySelector("[data-notifications-trigger]")
      .getAttribute("aria-expanded"),
  }));
  note(
    "[phone /harare] the bell opens the notifications centre from a place page, and there is only one in the DOM",
    open.dialogs.length === 1 &&
      /Notifications/i.test(open.dialogs[0] ?? "") &&
      open.groups === 1 &&
      open.bells === 1 &&
      open.expanded === "true",
    JSON.stringify(open),
  );
  await page.screenshot({
    path: `${SHOTS}/quick-actions-phone-place-notifications.png`,
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  note(
    "[phone /harare] Escape closes the centre and gives focus back to the bell",
    await page.evaluate(
      () =>
        document.querySelectorAll('[role="dialog"]').length === 0 &&
        document.activeElement?.hasAttribute("data-notifications-trigger"),
    ),
  );

  // Share on a place page: the place, its address, title and sentence.
  const placeSlug = new URL(page.url()).pathname.slice(1);
  const placeName = await page.evaluate(() =>
    document.querySelector("#current-conditions-heading")?.textContent?.trim(),
  );
  await page.tap("[data-share-trigger]");
  await page.waitForTimeout(300);
  const placeShare = await page.evaluate(() => window.__shared);
  const placeLabel = await page.getAttribute(
    "[data-share-trigger]",
    "aria-label",
  );
  note(
    "[phone /harare] Share names the place and shares its address, title and sentence",
    placeLabel === `Share weather for ${placeName}` &&
      placeShare.length === 1 &&
      // The place's canonical address (its slug may carry a suffix the URL in
      // the bar does not), never the bar's own address.
      placeShare[0].url.startsWith(`https://weather.mukoko.com/${placeSlug}`) &&
      placeShare[0].title === `${placeName} Weather` &&
      placeShare[0].text ===
        `Check the weather in ${placeName} on mukoko weather`,
    JSON.stringify({ placeLabel, placeShare }),
  );

  // Plain pages: solid at the top, the same three controls, the same place.
  for (const path of ["/locations", "/releases"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "commit", timeout: 120000 });
    await page.waitForSelector(GROUP, { timeout: 120000 });
    await hydrated(page, "[data-share-trigger]");
    await page.waitForTimeout(1000);
    const tag = `[phone ${path}]`;
    const items = await controls(page);
    const l = await look(page);
    const box = await rect(page, GROUP);
    note(
      `${tag} the same three controls in the same order, ${TOUCH}px each`,
      items.length === 3 &&
        THREE.every((re, i) => re.test(items[i].label ?? "")) &&
        items[0].label === "Share this page" &&
        items.every((c) => c.w === TOUCH && c.h === TOUCH && c.icon === 20),
      items.map((c) => c.label).join(" | "),
    );
    note(`${tag} solid at the top: the brand pill`, isSolid(l), lookText(l));
    note(
      `${tag} in the same place as on a place page`,
      Math.abs(box.x - topBox.x) <= 0.6 &&
        Math.abs(box.y - topBox.y) <= 0.6 &&
        Math.abs(box.w - topBox.w) <= 0.6,
      `${box.x},${box.y} ${box.w}x${box.h} vs ${topBox.x},${topBox.y} ${topBox.w}x${topBox.h}`,
    );
    note(
      `${tag} one group, one bell`,
      (await page.locator(GROUP).count()) === 1 &&
        (await page.locator("[data-notifications-trigger]").count()) === 1,
    );
    if (path === "/locations") {
      note(
        `${tag} Locations is current here`,
        (await page.getAttribute(
          `${GROUP} a[aria-label="All locations"]`,
          "aria-current",
        )) === "page",
      );
      await page.screenshot({
        path: `${SHOTS}/quick-actions-phone-locations.png`,
      });
    } else {
      await page.screenshot({
        path: `${SHOTS}/quick-actions-phone-releases.png`,
      });
      // Share the page: its address and its document title.
      await page.tap("[data-share-trigger]");
      await page.waitForTimeout(300);
      const shared = await page.evaluate(() => ({
        calls: window.__shared,
        href: location.href,
        title: document.title,
      }));
      note(
        `${tag} Share says "Share this page" and shares the page's address and title`,
        shared.calls.length === 1 &&
          shared.calls[0].url === shared.href &&
          shared.calls[0].title === shared.title &&
          shared.calls[0].text === undefined,
        JSON.stringify(shared),
      );
      // The bell here: one centre.
      await page.tap("[data-notifications-trigger]");
      await page.waitForSelector('[role="dialog"]', { timeout: 30000 });
      await page.waitForTimeout(600);
      note(
        `${tag} the bell opens one notifications centre`,
        (await page.locator('[role="dialog"]').count()) === 1,
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }
  await phone.close();

  // At rest the group is clear on bare sky at every phone width, with a
  // breadcrumb of one, two or three lines (the hero's first line of content
  // must start below the group's bottom edge, or the group would be solid
  // before the page has moved at all).
  for (const width of [360, 430]) {
    const ctx = await browser.newContext({
      viewport: { width, height: PHONE.height },
      hasTouch: true,
      isMobile: true,
    });
    await proxyApi(ctx);
    const wp = await ctx.newPage();
    await wp.goto(`${BASE}/harare`, { waitUntil: "commit", timeout: 120000 });
    await placeReady(wp);
    for (const [lines, text] of [
      ["as rendered", null],
      ["a longer trail", "Mashonaland West Province, Zimbabwe"],
      [
        "a very long trail",
        "The Democratic Republic of the Congo and its very long province name that wraps again",
      ],
    ]) {
      if (text) {
        await wp.evaluate((t) => {
          document.querySelector(
            "[data-sky-hero] [data-breadcrumb] li:last-child span",
          ).textContent = t;
        }, text);
        await wp.waitForTimeout(600);
      }
      const at = await wp.evaluate(() => {
        const g = document.querySelector("[data-quick-actions]");
        const first = document.querySelector(
          "[data-sky-hero] > div:nth-child(2) > p",
        );
        return {
          groupBottom: g.getBoundingClientRect().bottom,
          lineTop: first.getBoundingClientRect().top,
          past: g.hasAttribute("data-past-sky"),
          fill: getComputedStyle(g).backgroundColor,
        };
      });
      note(
        `[phone ${width}, ${lines}] at rest the hero's first line starts below the group and the group is clear`,
        at.lineTop > at.groupBottom && !at.past && at.fill === CLEAR_BG,
        `first line top ${at.lineTop.toFixed(1)} vs group bottom ${at.groupBottom.toFixed(1)}`,
      );
    }
    await ctx.close();
  }

  // Clipboard fallback: no share sheet, "Link copied".
  const clip = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await proxyApi(clip);
  const cp = await clip.newPage();
  await stubShare(cp, false);
  await cp.goto(`${BASE}/releases`, { waitUntil: "commit", timeout: 120000 });
  await cp.waitForSelector(GROUP, { timeout: 120000 });
  await hydrated(cp, "[data-share-trigger]");
  await cp.waitForTimeout(1000);
  await cp.tap("[data-share-trigger]");
  // The note shows for two seconds once the copy has finished.
  await cp
    .waitForFunction(
      () =>
        document.querySelector("[data-quick-actions] [role=status]")
          ?.textContent === "Link copied",
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  const noteText = await cp.evaluate(
    () =>
      document.querySelector("[data-quick-actions] [role=status]")?.textContent,
  );
  const copied = await cp
    .evaluate(() => navigator.clipboard.readText())
    .catch(() => null);
  note(
    'where there is no share sheet, Share copies the page address and says "Link copied"',
    noteText === "Link copied" && copied === `${BASE}/releases`,
    JSON.stringify({ noteText, copied }),
  );
  await cp.screenshot({ path: `${SHOTS}/quick-actions-phone-share-note.png` });
  await clip.close();

  // The loading skeleton: the group is live and clear before the weather
  // arrives, and is the same group afterwards.
  const slow = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
  });
  await proxyApi(slow, { delayWeather: 5000 });
  const sp = await slow.newPage();
  await sp.goto(`${BASE}/harare`, { waitUntil: "commit", timeout: 120000 });
  await sp.waitForSelector('[data-skeleton="hero"]', { timeout: 120000 });
  await sp.waitForSelector(GROUP, { timeout: 30000 });
  await sp.waitForTimeout(1200);
  const skel = await look(sp);
  const skelBox = await rect(sp, GROUP);
  note(
    "[phone loading] over the loading skeleton the group is already there, live and clear",
    isClear(skel) && (await controls(sp)).length === 3,
    lookText(skel),
  );
  await sp.screenshot({ path: `${SHOTS}/quick-actions-phone-loading.png` });
  await placeReady(sp);
  const loaded = await look(sp);
  const loadedBox = await rect(sp, GROUP);
  note(
    "[phone loading] when the hero arrives it is the same group, in the same place, still clear",
    isClear(loaded) &&
      Math.abs(loadedBox.x - skelBox.x) < 0.5 &&
      Math.abs(loadedBox.y - skelBox.y) < 0.5 &&
      (await sp.locator(GROUP).count()) === 1,
    lookText(loaded),
  );
  await slow.close();

  // ------------------------------------------------------------ the map
  const mapCtx = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
  });
  await proxyApi(mapCtx);
  await stubTiles(mapCtx);
  const mp = await mapCtx.newPage();
  await mp.goto(`${BASE}/harare/map`, { waitUntil: "commit", timeout: 120000 });
  await mp.waitForSelector(GROUP, { timeout: 120000 });
  await hydrated(mp, "[data-notifications-trigger]");
  await mp.waitForTimeout(2000);
  const mapItems = await controls(mp);
  const mapLook = await look(mp);
  const mapBox = await rect(mp, GROUP);
  const stack = await rect(
    mp,
    '[aria-label="Hide map layers"], [aria-label="Show map layers"]',
  );
  note(
    "[phone map] the dock is the same three controls, solid, and the only group",
    mapItems.length === 3 &&
      THREE.every((re, i) => re.test(mapItems[i].label ?? "")) &&
      isSolid(mapLook) &&
      (await mp.locator(GROUP).count()) === 1 &&
      (await mp.locator("[data-notifications-trigger]").count()) === 1,
    `${mapItems.map((c) => c.label).join(" | ")}; ${lookText(mapLook)}`,
  );
  note(
    "[phone map] the dock is in the same place as on every other page",
    Math.abs(mapBox.x - topBox.x) <= 0.6 &&
      Math.abs(mapBox.y - topBox.y) <= 0.6,
    `${mapBox.x},${mapBox.y} vs ${topBox.x},${topBox.y}`,
  );
  note(
    "[phone map] the map's own controls start under the group, and the map has no second Locations link",
    stack.y >= mapBox.bottom + 7 &&
      (await mp.locator('a[href="/locations"]').count()) === 1,
    `stack top ${stack.y.toFixed(1)}, group bottom ${mapBox.bottom.toFixed(1)}`,
  );
  await mp.screenshot({ path: `${SHOTS}/quick-actions-phone-map.png` });
  await mp.tap("[data-notifications-trigger]");
  await mp.waitForSelector('[role="dialog"]', { timeout: 30000 });
  await mp.waitForTimeout(600);
  note(
    "[phone map] the bell opens one notifications centre",
    (await mp.locator('[role="dialog"]').count()) === 1,
  );
  await mapCtx.close();

  // -------------------------------------------------------------- desktop
  for (const width of [DESKTOP.width, 1920]) {
    const desktop = await browser.newContext({
      viewport: { width, height: DESKTOP.height },
    });
    await proxyApi(desktop);
    await stubTiles(desktop);
    const wide = await desktop.newPage();
    await stubShare(wide, true);
    await wide.goto(`${BASE}/harare`, { waitUntil: "commit", timeout: 120000 });
    await placeReady(wide);
    const tag = `[${width} /harare]`;
    const items = await controls(wide);
    note(
      `${tag} Share, Notifications, Locations lead the pill; Map and the account icon follow`,
      items.length === 5 &&
        THREE.every((re, i) => re.test(items[i].label ?? "")) &&
        /^Weather map$|^Choose a location/.test(items[3].label ?? "") &&
        /^Sign in$|^Profile/.test(items[4].label ?? "") &&
        items.every((c) => c.w === TOUCH && c.h === TOUCH && c.icon === 20),
      items.map((c) => c.label).join(" | "),
    );
    const l = await look(wide);
    note(`${tag} clear over the sky at the top`, isClear(l), lookText(l));
    const box = await rect(wide, GROUP);
    const slot = await rect(wide, "[data-quick-actions-slot]");
    const header = await rect(wide, "[data-site-header]");
    note(
      `${tag} the group sits in the header row: on the slot the row leaves for it, level with the row`,
      Math.abs(box.right - slot.right) <= 1 &&
        Math.abs(box.w - slot.w) <= 1 &&
        Math.abs(box.y + box.h / 2 - (header.y + header.h / 2)) <= 1.5,
      `group ${box.x.toFixed(1)}..${box.right.toFixed(1)} y ${box.y}, slot ${slot.x.toFixed(1)}..${slot.right.toFixed(1)}, header ${header.h.toFixed(1)} tall`,
    );
    if (width === DESKTOP.width) {
      await wide.screenshot({
        path: `${SHOTS}/quick-actions-desktop-place-top.png`,
      });
      await scrollTo(wide, 60);
      const solid = await look(wide);
      note(
        `${tag} once the header has its own surface behind the group (scrolled) it is solid`,
        isSolid(solid),
        lookText(solid),
      );
      await wide.screenshot({
        path: `${SHOTS}/quick-actions-desktop-place-scrolled.png`,
      });
      const stays = await rect(wide, GROUP);
      note(
        `${tag} and has not moved`,
        Math.abs(stays.y - box.y) < 0.5 && Math.abs(stays.x - box.x) < 0.5,
      );
      await scrollTo(wide, 0);
      note(
        `${tag} back at the top it is clear again`,
        isClear(await look(wide)),
      );

      // The bell under the group: one popover, anchored under the bell.
      await wide.click("[data-notifications-trigger]");
      await wide.waitForSelector('[role="dialog"]', { timeout: 30000 });
      await wide.waitForTimeout(800);
      const pop = await rect(wide, '[role="dialog"]');
      const bell = await rect(wide, "[data-notifications-trigger]");
      note(
        `${tag} the bell opens one popover, hung under the bell and right-aligned with it`,
        (await wide.locator('[role="dialog"]').count()) === 1 &&
          Math.abs(pop.right - bell.right) <= 1.5 &&
          pop.y >= bell.bottom &&
          pop.y - bell.bottom <= 16,
        `popover ${pop.x.toFixed(1)}..${pop.right.toFixed(1)} y ${pop.y.toFixed(1)}, bell right ${bell.right.toFixed(1)} bottom ${bell.bottom.toFixed(1)}`,
      );
      await wide.screenshot({
        path: `${SHOTS}/quick-actions-desktop-place-notifications.png`,
      });
      await wide.keyboard.press("Escape");
      await wide.waitForTimeout(400);
      await wide.click("[data-share-trigger]");
      await wide.waitForTimeout(300);
      const shared = await wide.evaluate(() => window.__shared);
      note(
        `${tag} Share shares the place's address`,
        shared.length === 1 &&
          /^https:\/\/weather\.mukoko\.com\/.+/.test(shared[0].url),
        JSON.stringify(shared),
      );
    }
    await desktop.close();
  }

  // Plain page and the map at desktop width.
  const desk2 = await browser.newContext({ viewport: DESKTOP });
  await proxyApi(desk2);
  await stubTiles(desk2);
  const dp = await desk2.newPage();
  for (const path of ["/locations", "/harare/map"]) {
    await dp.goto(`${BASE}${path}`, { waitUntil: "commit", timeout: 120000 });
    await dp.waitForSelector(GROUP, { timeout: 120000 });
    await dp.waitForTimeout(2000);
    const tag = `[1280 ${path}]`;
    const items = await controls(dp);
    const l = await look(dp);
    const isMap = path.endsWith("/map");
    note(
      `${tag} ${isMap ? "the dock is the three controls" : "the pill is the three controls, then Map and the account icon"}, solid at the top, one group`,
      items.length === (isMap ? 3 : 5) &&
        THREE.every((re, i) => re.test(items[i].label ?? "")) &&
        isSolid(l) &&
        (await dp.locator(GROUP).count()) === 1,
      `${items.map((c) => c.label).join(" | ")}; ${lookText(l)}`,
    );
    await dp.screenshot({
      path: `${SHOTS}/quick-actions-desktop-${isMap ? "map" : "locations"}.png`,
    });
  }
  await desk2.close();

  // ------------------------------------------- routes that must not double
  const routes = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
  });
  await proxyApi(routes);
  await stubTiles(routes);
  const rp = await routes.newPage();
  await stubShare(rp, true);

  // An unknown place's map route is the not-found page: it draws a site
  // header, which brings the one group. It once had a second one (a dock the
  // chrome added for the path) and so two bells and two centres.
  await rp.goto(`${BASE}/harere/map`, { waitUntil: "commit", timeout: 120000 });
  await rp.waitForSelector("[data-site-header], " + GROUP, { timeout: 120000 });
  await hydrated(rp, "[data-notifications-trigger]");
  await rp.waitForTimeout(1500);
  note(
    "[phone /harere/map] an unknown place: the not-found page has a header and exactly one group and one bell",
    (await rp.locator("[data-site-header]").count()) === 1 &&
      (await rp.locator(GROUP).count()) === 1 &&
      (await rp.locator("[data-notifications-trigger]").count()) === 1,
    JSON.stringify({
      headers: await rp.locator("[data-site-header]").count(),
      groups: await rp.locator(GROUP).count(),
      bells: await rp.locator("[data-notifications-trigger]").count(),
    }),
  );
  await rp.tap("[data-notifications-trigger]");
  await rp.waitForSelector('[role="dialog"]', { timeout: 30000 });
  await rp.waitForTimeout(600);
  note(
    "[phone /harere/map] one tap on the bell opens exactly one notifications centre",
    (await rp.locator('[role="dialog"]').count()) === 1,
  );
  await rp.screenshot({ path: `${SHOTS}/quick-actions-phone-unknown-map.png` });

  // The embed's iframe views keep their header and footer and get no group.
  await rp.goto(`${BASE}/embed/widget?location=harare`, {
    waitUntil: "commit",
    timeout: 120000,
  });
  await rp.waitForSelector("[data-site-header]", { timeout: 120000 });
  await rp.waitForTimeout(2500);
  note(
    "[embed /embed/widget] no Quick actions group and no bell, and the header it already had",
    (await rp.locator(GROUP).count()) === 0 &&
      (await rp.locator("[data-notifications-trigger]").count()) === 0 &&
      (await rp.locator("[data-quick-actions-slot]").count()) === 0 &&
      (await rp.locator("[data-site-header]").count()) === 1,
  );

  // The wall display is a kiosk: none.
  await rp.goto(`${BASE}/display`, { waitUntil: "commit", timeout: 120000 });
  await rp.waitForTimeout(6000);
  note(
    "[display /display] no Quick actions group",
    (await rp.locator(GROUP).count()) === 0,
  );

  // A link shared from a plain page carries no query string and no fragment.
  await rp.goto(`${BASE}/releases?utm=x&token=1#top`, {
    waitUntil: "commit",
    timeout: 120000,
  });
  await rp.waitForSelector(GROUP, { timeout: 120000 });
  await hydrated(rp, "[data-share-trigger]");
  await rp.waitForTimeout(1000);
  await rp.tap("[data-share-trigger]");
  await rp.waitForTimeout(300);
  const stripped = await rp.evaluate(() => window.__shared);
  note(
    "[phone /releases?utm=x&token=1#top] Share shares the page's address without its query string and fragment",
    stripped.length === 1 && stripped[0].url === `${BASE}/releases`,
    JSON.stringify(stripped),
  );
  await routes.close();

  // ---------------------------------------- the header row at every width
  // Nothing may overlap the group or the brand, nothing may leave the screen,
  // and the controls are the ones the row can hold: three up to 767px, four
  // (the account icon) from 768px, five (Map) from 1024px.
  for (const width of [
    360, 393, 640, 700, 767, 768, 820, 900, 1023, 1024, 1280, 1920,
  ]) {
    const ctx = await browser.newContext({
      viewport: { width, height: 800 },
      ...(width < 640 ? { hasTouch: true, isMobile: true } : {}),
    });
    await proxyApi(ctx);
    const hp = await ctx.newPage();
    await hp.goto(`${BASE}/locations`, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await hp.waitForSelector(`[data-site-header], ${GROUP}`, {
      timeout: 120000,
    });
    await hp.waitForSelector(GROUP, { timeout: 120000 });
    await hp.waitForTimeout(1200);
    const r = await hp.evaluate(() => {
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { l: b.left, r: b.right, t: b.top, b: b.bottom };
      };
      const visible = (el) => el.getClientRects().length > 0;
      const header = document.querySelector("[data-site-header]");
      const row = header.firstElementChild;
      const group = box(document.querySelector("[data-quick-actions]"));
      const controls = [
        ...document.querySelectorAll(
          "[data-quick-actions] a, [data-quick-actions] button",
        ),
      ].filter(visible).length;
      const brand = box(header.querySelector("[data-header-ink] a"));
      const nav = [...header.querySelectorAll("nav a, nav button")]
        .filter(visible)
        .map(box);
      const navBox = nav.length
        ? {
            l: Math.min(...nav.map((n) => n.l)),
            r: Math.max(...nav.map((n) => n.r)),
          }
        : null;
      const hits = (a, b) => a && b && a.r > b.l + 0.5 && a.l < b.r - 0.5;
      return {
        controls,
        docOver:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        rowOver: row.scrollWidth - row.clientWidth,
        navUnderGroup: hits(navBox, group),
        brandOverNav: hits(brand, navBox),
        brandUnderGroup: hits(brand, group),
        gap: navBox ? Math.round(group.l - navBox.r) : null,
        brandGap: navBox ? Math.round(navBox.l - brand.r) : null,
      };
    });
    const want = width < 768 ? 3 : width < 1024 ? 4 : 5;
    note(
      `[header ${width}px] ${want} controls, nothing under the group, the brand clear of the nav, nothing past the screen`,
      r.controls === want &&
        !r.navUnderGroup &&
        !r.brandOverNav &&
        !r.brandUnderGroup &&
        r.docOver <= 0 &&
        r.rowOver <= 0,
      JSON.stringify(r),
    );
    if ([640, 768, 1024].includes(width)) {
      await hp.screenshot({
        path: `${SHOTS}/quick-actions-header-${width}.png`,
        clip: { x: 0, y: 0, width, height: 100 },
      });
    }
    await ctx.close();
  }

  // ----------------------------------- classic scrollbars and a modal open
  // Headless Chromium hides scrollbars; the real ones are 15px. The group is
  // on the row's grid with them, and opening a modal (Radix puts a margin on
  // the body, the scrollbar stays) does not move it.
  const classic = await chromium.launch({
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  for (const width of [1280, 1920]) {
    const ctx = await classic.newContext({
      viewport: { width, height: 700 },
    });
    await proxyApi(ctx);
    const cp2 = await ctx.newPage();
    await cp2.goto(`${BASE}/releases`, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await cp2.waitForSelector(GROUP, { timeout: 120000 });
    await hydrated(cp2, "[data-notifications-trigger]");
    await cp2.waitForTimeout(1500);
    const bar = await cp2.evaluate(
      () => innerWidth - document.documentElement.clientWidth,
    );
    const before = await rect(cp2, GROUP);
    const slot = await rect(cp2, "[data-quick-actions-slot]");
    note(
      `[${width}px, ${bar}px scrollbar] the group's right edge is the header slot's, with a real scrollbar`,
      bar > 0 && Math.abs(before.right - slot.right) <= 1,
      `group ${before.right}, slot ${slot.right}`,
    );
    await cp2.getByRole("button", { name: "My Weather" }).click();
    await cp2.waitForSelector('[role="dialog"]', { timeout: 30000 });
    await cp2.waitForTimeout(800);
    const during = await rect(cp2, GROUP);
    note(
      `[${width}px] opening a modal does not move the group`,
      Math.abs(during.x - before.x) < 0.5 &&
        Math.abs(during.right - before.right) < 0.5,
      `${before.right} to ${during.right}`,
    );
    await ctx.close();
  }
  await classic.close();

  // ----------------------------------------------- the map's bottom sheet
  // With the capacity note showing (the tiles host is answered with its blank
  // placeholder, so the probe says "busy") the sheet is at its tallest: it must
  // stop under the layers and locate controls, not cover them. Needs the
  // capacity note (the map's live-layer probe); a tree without it skips this.
  for (const [width, height] of [
    [375, 667],
    [360, 640],
  ]) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      hasTouch: true,
      isMobile: true,
    });
    await proxyApi(ctx);
    const blank = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    await ctx.route("**/weather-tiles.mukoko.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: blank,
        headers: {
          "X-Map-Tile": "empty",
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "X-Map-Tile",
        },
      }),
    );
    const sp2 = await ctx.newPage();
    await sp2.goto(`${BASE}/harare/map`, {
      waitUntil: "commit",
      timeout: 120000,
    });
    await sp2.waitForSelector('[data-slot="map-sheet"]', { timeout: 120000 });
    await hydrated(sp2, "[data-notifications-trigger]");
    await sp2.waitForTimeout(2000);
    await sp2
      .getByRole("button", { name: /^Rain$/ })
      .first()
      .click()
      .catch(() => {});
    const shown = await sp2
      .waitForSelector('[data-slot="layer-capacity-note"]', { timeout: 20000 })
      .then(
        () => true,
        () => false,
      );
    if (!shown) {
      console.log(
        `SKIP  [phone map ${width}x${height}] no capacity note in this build`,
      );
      await ctx.close();
      continue;
    }
    await sp2.waitForTimeout(1200);
    const m = await sp2.evaluate(() => {
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { t: b.top, b: b.bottom, l: b.left, r: b.right };
      };
      const sheetEl = document.querySelector('[data-slot="map-sheet"]');
      return {
        sheet: box(sheetEl),
        scrolls: sheetEl.scrollHeight > sheetEl.clientHeight,
        targets: [
          document.querySelector("[data-quick-actions]"),
          document.querySelector(
            '[aria-label="Hide map layers"], [aria-label="Show map layers"]',
          ),
          document.querySelector(
            '[aria-label="Centre the map on my location"]',
          ),
          document.querySelector('[aria-label^="Close map"]'),
        ].map(box),
      };
    });
    const covered = m.targets.filter(
      (t) =>
        m.sheet.t < t.b &&
        m.sheet.b > t.t &&
        m.sheet.l < t.r &&
        m.sheet.r > t.l,
    );
    note(
      `[phone map ${width}x${height}] with the capacity note the sheet does not cover the group, the layers and locate controls or the close button`,
      covered.length === 0,
      `sheet top ${m.sheet.t.toFixed(0)}, controls end ${Math.max(...m.targets.map((t) => t.b)).toFixed(0)}, scrolls inside: ${m.scrolls}`,
    );
    await sp2.screenshot({
      path: `${SHOTS}/quick-actions-phone-map-${width}x${height}.png`,
    });
    await ctx.close();
  }

  await browser.close();
  finish();
});
