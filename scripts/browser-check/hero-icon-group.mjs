// The hero's phone icon group (`.hadeda`): Share and My Location (the round
// arrow link to `/`) in ONE round pill fixed to the top of the screen.
//
//   BASE=http://localhost:3100 node scripts/browser-check/hero-icon-group.mjs
//
// What only a browser can show: that the group really stays where it is while
// the page scrolls (an ancestor with a transform, filter or backdrop-filter
// would make it scroll away), that it lines up with the hero's top row at the
// top of the page, that My Location is a 49px link to `/` in it (the account
// avatar it swapped places with is the bottom bar's: see account-menu-bar.mjs),
// and that from `sm` up there is no fixed group and Share is back in the top
// row.
import {
  BASE,
  PHONE,
  SHOTS,
  chromium,
  proxyApi,
  reporter,
  run,
} from "./harness.mjs";

const { note, finish } = reporter();

const rect = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right };
  }, selector);

run(async () => {
  const browser = await chromium.launch();

  // Phone.
  const phone = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
  });
  await proxyApi(phone);
  const page = await phone.newPage();
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hadeda", { timeout: 20000 });
  await page.waitForTimeout(1500);

  const style = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".hadeda"));
    return { position: cs.position, backdrop: cs.backdropFilter };
  });
  note("the group is position: fixed", style.position === "fixed");
  note(
    "the group itself has no backdrop-filter (it would capture a fixed descendant)",
    style.backdrop === "none",
  );

  const top = await rect(page, ".hadeda");
  const row = await rect(page, "[data-sky-hero] > div");
  note(
    "at the top of the page the group is level with the hero's top row",
    Math.abs(top.y - row.y) <= 1,
    `group y ${top.y.toFixed(1)}, row y ${row.y.toFixed(1)}`,
  );
  note(
    "the group sits at the right gutter, inside the screen",
    top.right <= PHONE.width - 15 && top.right >= PHONE.width - 17,
    `right edge ${top.right.toFixed(1)} of ${PHONE.width}`,
  );
  const crumb = await rect(page, "[data-sky-hero] > div > div:first-child");
  note(
    "the breadcrumb leaves room for the group (they do not overlap)",
    crumb.x + crumb.w - 0.5 <= top.x ||
      (await page.evaluate(() => {
        const c = document.querySelector(
          "[data-sky-hero] > div > div:first-child",
        );
        const pr = parseFloat(getComputedStyle(c).paddingRight);
        return pr > 100;
      })),
  );

  const moved = [];
  for (const y of [300, 1200, 4000]) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(250);
    const r = await rect(page, ".hadeda");
    moved.push(Math.abs(r.y - top.y) + Math.abs(r.x - top.x));
  }
  note(
    "the group stays put while the page scrolls",
    moved.every((d) => d < 0.5),
    `moved ${moved.map((d) => d.toFixed(1)).join(", ")} px`,
  );

  // The loading skeleton draws the same group with two bars; wait for the
  // real controls.
  await page.waitForSelector('.hadeda a[aria-label="My Location"]', {
    timeout: 60000,
  });
  const here = await rect(page, '.hadeda a[aria-label="My Location"]');
  const href = await page.getAttribute(
    '.hadeda a[aria-label="My Location"]',
    "href",
  );
  note(
    "My Location is a 49px round link to / inside the group",
    here &&
      href === "/" &&
      Math.abs(here.w - 49) < 0.6 &&
      Math.abs(here.h - 49) < 0.6 &&
      here.x >= top.x &&
      here.right <= top.right,
    here ? `${here.w}x${here.h}` : "no link",
  );
  note(
    "the group holds no account menu (it is the bottom bar's first slot)",
    (await page.locator(".hadeda details").count()) === 0,
  );
  await page.screenshot({ path: `${SHOTS}/hero-icon-group.png` });
  await phone.close();

  // Desktop width: no fixed group; Share is in the top row.
  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await proxyApi(desktop);
  const wide = await desktop.newPage();
  await wide.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await wide.waitForSelector("#current-conditions-heading", { timeout: 20000 });
  const hidden = await wide.evaluate(
    () =>
      getComputedStyle(document.querySelector(".hadeda")).display === "none",
  );
  const share = await wide.evaluate(() => {
    const b = document.querySelector(
      '[data-sky-hero] button.kestrel-round[aria-label^="Share weather"]',
    );
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && getComputedStyle(b).position !== "fixed";
  });
  note("from `sm` up the fixed group is not drawn", hidden);
  note("from `sm` up Share is in the hero's top row", share);
  await desktop.close();

  await browser.close();
  finish();
});
