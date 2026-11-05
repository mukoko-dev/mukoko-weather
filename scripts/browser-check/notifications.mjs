// The notifications centre (alerts for your places, and their settings) in a
// real browser (mukoko-dev/mukoko-weather#289).
//
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/notifications.mjs
//
// What only a browser can show: that a forecast stored on the device really
// becomes an alert (frost, lightning, flooding from the forecast; flooding and
// wildfire from community reports), that the bell and the phone menu open the
// centre (a bottom sheet on a phone, a popover under the bell from `sm`), that
// the alerts say what they are and are not, that the empty state is honest,
// that the report buttons open the wizard on the right type, that the
// settings persist across a reload, that every control is a 49px target and
// every word 14px or more, that nothing overflows sideways, and that the
// keyboard works (Tab stays inside the sheet, Escape closes and gives focus
// back).
//
// The network is answered here (`memory-harness.mjs` `mockNetwork`, with the
// forecast and the community reports replaced by the cases below): a run
// spends no provider quota and does not depend on the weather. No write
// leaves the browser.
import { BASE, SHOTS, chromium, reporter, run } from "./harness.mjs";
import { mockNetwork, weatherPayload } from "./memory-harness.mjs";

const { note, finish } = reporter();

/** The account menu's trigger: the avatar, first slot of the phone bottom bar. */
const ACCOUNT_TRIGGER =
  '[data-slot="mzizi-bottom-nav"] [data-slot="account-menu"] summary';

const VIEWPORTS = [
  { name: "393x852", width: 393, height: 852, phone: true },
  { name: "375x667", width: 375, height: 667, phone: true },
  { name: "340x640", width: 340, height: 640, phone: true },
  { name: "1280x800", width: 1280, height: 800, phone: false },
];
const FLOOR = 48.5; // 49px, allowing for sub-pixel rounding
const MIN_TEXT = 13.9; // 14px

/** What the mocked Worker answers for the place under test. */
const state = { scenario: "alerts" };

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

/** The forecast for the scenario: a cold night, a storm and heavy rain, or nothing. */
function forecast(lat, lon) {
  const payload = weatherPayload(lat, lon);
  if (state.scenario !== "alerts") {
    // Quiet: warm nights, clear sky, no rain.
    payload.hourly.temperature_2m = payload.hourly.temperature_2m.map(() => 18);
    payload.hourly.weather_code = payload.hourly.weather_code.map(() => 0);
    payload.hourly.precipitation = payload.hourly.precipitation.map(() => 0);
    payload.insights.thunderstormProbability = 0;
    return payload;
  }
  const hourNow = Number(payload.current.time.slice(11, 13));
  // Two consecutive cold nights, so one is inside the next 24 hours whatever
  // the time of the run.
  for (const night of [22, 46]) {
    for (let i = night; i <= night + 8; i++)
      payload.hourly.temperature_2m[i] = 1;
  }
  // Thunderstorms three hours from now, for three hours.
  for (let i = hourNow + 3; i <= hourNow + 5; i++) {
    payload.hourly.weather_code[i] = 95;
  }
  // Heavy rain: 15 mm an hour for four hours, 60 mm in all.
  for (let i = hourNow + 2; i <= hourNow + 5; i++) {
    payload.hourly.precipitation[i] = 15;
  }
  return payload;
}

/** The community reports for the scenario. */
function reports() {
  if (state.scenario !== "alerts") return { reports: [], count: 0 };
  const base = { upvotes: 0, verified: false, locationName: "Harare" };
  return {
    count: 2,
    reports: [
      {
        ...base,
        id: "r1",
        reportType: "wildfire",
        severity: "moderate",
        reportedAt: minutesAgo(20),
      },
      {
        ...base,
        id: "r2",
        reportType: "flooding",
        severity: "severe",
        reportedAt: minutesAgo(35),
      },
    ],
  };
}

async function newContext(browser, viewport, phone, permission = "default") {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: phone,
    isMobile: phone,
    serviceWorkers: "block",
  });
  // Headless Chromium reports notifications as blocked. A person who has not
  // decided sees "default": say so, so the push row shows the state under test
  // (the alert service is not live: "Not switched on yet"). The empty-state run
  // below says "denied" instead, to see the row for a blocked browser.
  await context.addInitScript((value) => {
    Object.defineProperty(Notification, "permission", { get: () => value });
  }, permission);
  await mockNetwork(context);
  // Later routes run first: answer the forecast and the reports for the
  // scenario, hand everything else back to the shared mock.
  await context.route("https://weather-api.mukoko.com/**", async (route) => {
    const url = new URL(route.request().url());
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "*",
    };
    if (route.request().method() === "GET" && url.pathname === "/v1/weather") {
      const lat = Number(url.searchParams.get("lat")) || -17.83;
      const lon = Number(url.searchParams.get("lon")) || 31.05;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          ...cors,
          "x-weather-provider": "open-meteo:blend",
          "x-cache": "MISS",
          "x-enrichment": "none",
        },
        body: JSON.stringify(forecast(lat, lon)),
      });
    }
    if (route.request().method() === "GET" && url.pathname === "/v1/reports") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: cors,
        body: JSON.stringify(reports()),
      });
    }
    return route.fallback();
  });
  return context;
}

/** Load the place so its forecast is stored on the device, and scroll so the report lists load. */
async function loadPlace(page) {
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#current-conditions-heading", {
    timeout: 30000,
  });
  // The report lane and the recent-reports card fetch when they come near.
  for (const y of [800, 2000, 4000, 8000, 0]) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
}

/** Open the page the bell is on (the phone header is not drawn over the sky hero, so use a plain page). */
async function gotoBellPage(page, phone) {
  if (!phone) return;
  await page.goto(`${BASE}/about`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-notifications-trigger]", {
    timeout: 20000,
  });
}

const dialog = (page) => page.locator('[role="dialog"]').last();

/** Every visible control in the dialog is 49px tall; returns the offenders. */
const smallTargets = (page) =>
  page.evaluate((floor) => {
    const root = [...document.querySelectorAll('[role="dialog"]')].pop();
    if (!root) return ["no dialog"];
    const bad = [];
    for (const el of root.querySelectorAll(
      'button, a[href], select, [role="switch"], [role="radio"]',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest("[aria-hidden='true']")) continue;
      if (r.height < floor) {
        bad.push(
          `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${r.width.toFixed(0)}x${r.height.toFixed(1)}`,
        );
      }
    }
    return bad;
  }, FLOOR);

/** Visible text in the dialog smaller than 14px; returns the offenders. */
const smallText = (page) =>
  page.evaluate((min) => {
    const root = [...document.querySelectorAll('[role="dialog"]')].pop();
    if (!root) return ["no dialog"];
    const bad = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest(".sr-only, [aria-hidden='true']")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const px = parseFloat(cs.fontSize);
      if (px < min) bad.add(`"${n.textContent.trim().slice(0, 24)}" ${px}px`);
    }
    return [...bad];
  }, MIN_TEXT);

/** Sideways overflow: the page, and the dialog's own content. */
const overflow = (page) =>
  page.evaluate(() => {
    const root = [...document.querySelectorAll('[role="dialog"]')].pop();
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      dialog: root ? root.scrollWidth - root.clientWidth : 0,
    };
  });

async function checkViewport(browser, viewport) {
  const { name, phone } = viewport;
  const tag = `[${name}]`;
  const context = await newContext(browser, viewport, phone);
  const page = await context.newPage();

  // ---------------------------------------------------------------- alerts
  state.scenario = "alerts";
  await loadPlace(page);
  await gotoBellPage(page, phone);

  await page
    .waitForSelector("[data-alert-dot]", { timeout: 15000 })
    .catch(() => {});
  const dot = await page.locator("[data-alert-dot]").count();
  const bellName = await page
    .locator("[data-notifications-trigger]")
    .first()
    .getAttribute("aria-label");
  note(
    `${tag} the bell shows a dot and says how many alerts in its name`,
    dot === 1 && /^Notifications, \d+ alerts?$/.test(bellName ?? ""),
    bellName ?? "no bell",
  );

  await page.locator("[data-notifications-trigger]").first().click();
  await dialog(page).waitFor({ state: "visible", timeout: 10000 });
  await page.waitForSelector("article", { timeout: 10000 });
  // The community reports are read when the centre opens and arrive a moment
  // later; the list is announced politely when they do.
  await page
    .waitForSelector("text=Community report: wildfire", { timeout: 8000 })
    .catch(() => {});
  const articles = await page
    .locator('[role="dialog"] article')
    .allInnerTexts();
  const text = articles.join(" | ").replace(/\s+/g, " ");
  note(
    `${tag} the bell opens the centre with the alerts`,
    articles.length >= 3,
  );
  note(
    `${tag} a frost advisory from the stored forecast, tonight, at the place`,
    /Frost advisory/.test(text) &&
      /Harare/.test(text) &&
      /(Tonight|Early this morning), between \d\d:00 and \d\d:00/.test(text) &&
      /low near 1°C/.test(text),
  );
  note(
    `${tag} a lightning advisory and a flood advisory`,
    /Lightning advisory/.test(text) &&
      /Thunderstorms are likely/.test(text) &&
      /Flood advisory/.test(text) &&
      /Heavy rain is possible/.test(text),
  );
  note(
    `${tag} forecast alerts say advisory, not an official warning, and when the forecast is from (place time)`,
    (text.match(/From the forecast, not an official warning/g) ?? []).length >=
      3 && /Forecast as of \d\d:\d\d \(Harare time\)/.test(text),
  );
  note(
    `${tag} community reports are labelled unverified and a wildfire is claimed only from a report`,
    /Community report: wildfire/.test(text) &&
      /Community report: flooding/.test(text) &&
      /Community report, unverified/.test(text) &&
      /call your local emergency services/.test(text) &&
      !/\b(911|999|112)\b/.test(text),
  );
  const buttonsText = await page
    .locator('[role="dialog"] button')
    .allInnerTexts();
  note(
    `${tag} Report flooding is offered on flooding alerts; Report wildfire only once the type exists`,
    buttonsText.includes("Report flooding") &&
      !buttonsText.includes("Report wildfire"),
    JSON.stringify(buttonsText.filter((b) => /Report/.test(b))),
  );
  note(
    `${tag} the list is announced politely`,
    (await page.locator('[role="dialog"] [aria-live="polite"]').count()) >= 1,
  );
  const wide = await overflow(page);
  note(
    `${tag} no horizontal overflow with the list open`,
    wide.page <= 0 && wide.dialog <= 0,
    JSON.stringify(wide),
  );
  const smallA = await smallTargets(page);
  note(
    `${tag} every control in the list is a 49px target`,
    smallA.length === 0,
    smallA.join("; "),
  );
  const smallTextA = await smallText(page);
  note(
    `${tag} no text under 14px in the list`,
    smallTextA.length === 0,
    smallTextA.join("; "),
  );
  await page.screenshot({ path: `${SHOTS}/notifications-${name}-list.png` });

  // The report button opens the wizard on the type, for the alert's place.
  await page.getByRole("button", { name: "Report flooding" }).first().click();
  await page.waitForSelector("text=Tell us more about the flooding", {
    timeout: 10000,
  });
  note(
    `${tag} Report flooding opens the report wizard already on flooding`,
    (await page.getByText("Report Weather").count()) >= 1 &&
      (await page.getByRole("radio", { name: "Moderate" }).count()) === 1,
  );
  await page.screenshot({ path: `${SHOTS}/notifications-${name}-report.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // -------------------------------------------------------------- keyboard
  await page.locator("[data-notifications-trigger]").first().click();
  await dialog(page).waitFor({ state: "visible" });
  if (phone) {
    // A sheet traps focus: many Tabs never leave it.
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    );
    note(`${tag} Tab stays inside the sheet`, inside);
  } else {
    const focusInside = await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    );
    note(`${tag} focus moves into the popover when it opens`, focusInside);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const closed = (await page.locator('[role="dialog"]').count()) === 0;
  const focusOnBell = await page.evaluate(() =>
    document.activeElement?.hasAttribute("data-notifications-trigger"),
  );
  note(`${tag} Escape closes the centre`, closed);
  note(`${tag} Escape gives focus back to the bell`, focusOnBell === true);

  // ------------------------------------------------------------- settings
  await page.locator("[data-notifications-trigger]").first().click();
  await dialog(page).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Alert settings" }).click();
  await page.waitForSelector("#alert-kind-frost", { timeout: 10000 });
  const labels = await page.evaluate(() =>
    ["frost", "lightning", "wildfire", "flooding"].map((k) => {
      const el = document.getElementById(`alert-kind-${k}`);
      return el
        ? `${el.firstElementChild?.firstElementChild?.textContent}:${el.getAttribute("aria-checked")}:${el.getAttribute("role")}`
        : "missing";
    }),
  );
  note(
    `${tag} four switches named Frost, Lightning, Wildfire, Flooding, all on by default`,
    JSON.stringify(labels) ===
      JSON.stringify([
        "Frost:true:switch",
        "Lightning:true:switch",
        "Wildfire:true:switch",
        "Flooding:true:switch",
      ]),
    JSON.stringify(labels),
  );
  const settingsText = await dialog(page).innerText();
  note(
    `${tag} Delivery: in the app always on, push not switched on yet, Telegram and Campfire coming soon, best effort`,
    /Always on/.test(settingsText) &&
      /Push on this device/.test(settingsText) &&
      /Not switched on yet/.test(settingsText) &&
      (settingsText.match(/Coming soon/g) ?? []).length === 2 &&
      /Telegram/.test(settingsText) &&
      /Campfire/.test(settingsText) &&
      /Delivery is best effort\./.test(settingsText),
  );
  const pushButtons = await page
    .locator('[role="dialog"] button')
    .allInnerTexts();
  note(
    `${tag} no button does nothing: push, Telegram and Campfire offer no control`,
    !pushButtons.some((b) => /push|telegram|campfire/i.test(b)),
    JSON.stringify(pushButtons),
  );
  note(
    `${tag} quiet hours are off by default`,
    (await page.locator("#quiet-hours").getAttribute("aria-checked")) ===
      "false" && (await page.locator("#quiet-from").count()) === 0,
  );

  // Switch frost off and quiet hours on, with a different range.
  await page.locator("#alert-kind-frost").click();
  await page.locator("#quiet-hours").click();
  await page.waitForSelector("#quiet-from", { timeout: 5000 });
  await page.selectOption("#quiet-from", "21");
  await page.selectOption("#quiet-to", "5");
  const widthSettings = await overflow(page);
  note(
    `${tag} no horizontal overflow in the settings`,
    widthSettings.page <= 0 && widthSettings.dialog <= 0,
    JSON.stringify(widthSettings),
  );
  const smallB = await smallTargets(page);
  note(
    `${tag} every control in the settings is a 49px target`,
    smallB.length === 0,
    smallB.join("; "),
  );
  const smallTextB = await smallText(page);
  note(
    `${tag} no text under 14px in the settings`,
    smallTextB.length === 0,
    smallTextB.join("; "),
  );
  await page.screenshot({
    path: `${SHOTS}/notifications-${name}-settings.png`,
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // ------------------------------------------------------- persists on reload
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-notifications-trigger]", {
    timeout: 20000,
  });
  await page.waitForTimeout(2500);
  await page.locator("[data-notifications-trigger]").first().click();
  await dialog(page).waitFor({ state: "visible" });
  await page.waitForTimeout(1500);
  const listAfter = (await dialog(page).innerText()).replace(/\s+/g, " ");
  note(
    `${tag} a switched-off kind is gone from the list after a reload`,
    !/Frost advisory/.test(listAfter) && /Lightning advisory/.test(listAfter),
  );
  await page.getByRole("button", { name: "Alert settings" }).click();
  await page.waitForSelector("#alert-kind-frost");
  const persisted = await page.evaluate(() => ({
    frost: document
      .getElementById("alert-kind-frost")
      ?.getAttribute("aria-checked"),
    lightning: document
      .getElementById("alert-kind-lightning")
      ?.getAttribute("aria-checked"),
    quiet: document.getElementById("quiet-hours")?.getAttribute("aria-checked"),
    from: document.getElementById("quiet-from")?.value,
    to: document.getElementById("quiet-to")?.value,
  }));
  note(
    `${tag} the settings persist after a reload (frost off, quiet 21:00 to 05:00)`,
    persisted.frost === "false" &&
      persisted.lightning === "true" &&
      persisted.quiet === "true" &&
      persisted.from === "21" &&
      persisted.to === "5",
    JSON.stringify(persisted),
  );
  await page.getByRole("button", { name: "Back to alerts" }).click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await context.close();

  // ---------------------------------------------------------------- empty
  state.scenario = "quiet";
  const quiet = await newContext(browser, viewport, phone, "denied");
  const quietPage = await quiet.newPage();
  await loadPlace(quietPage);
  await gotoBellPage(quietPage, phone);
  await quietPage.waitForTimeout(3500);
  const quietDot = await quietPage.locator("[data-alert-dot]").count();
  note(
    `${tag} no dot on the bell when there is nothing to tell`,
    quietDot === 0,
  );
  await quietPage.locator("[data-notifications-trigger]").first().click();
  await dialog(quietPage).waitFor({ state: "visible" });
  await quietPage.waitForSelector("text=No alerts for your places right now", {
    timeout: 10000,
  });
  const emptyText = (await dialog(quietPage).innerText()).replace(/\s+/g, " ");
  note(
    `${tag} the empty state says what was checked and when, honestly`,
    /No alerts for your places right now/.test(emptyText) &&
      /Checked 1 place, with forecasts last updated at \d\d:\d\d\./.test(
        emptyText,
      ) &&
      /Alert settings/.test(emptyText),
    emptyText.slice(0, 220),
  );
  const emptyButtons = await quietPage
    .locator('[role="dialog"] button')
    .allInnerTexts();
  note(
    `${tag} the empty state offers Report flooding (Report wildfire once the type exists)`,
    emptyButtons.includes("Report flooding") &&
      !emptyButtons.includes("Report wildfire"),
    JSON.stringify(emptyButtons),
  );
  await quietPage.getByRole("button", { name: "Alert settings" }).click();
  await quietPage.waitForSelector("#alert-kind-frost");
  const blockedText = (await dialog(quietPage).innerText()).replace(
    /\s+/g,
    " ",
  );
  note(
    `${tag} a browser that blocks notifications: push says Blocked and offers no button`,
    /Push on this device Blocked Notifications are blocked for this site/.test(
      blockedText,
    ) &&
      !(await quietPage.locator('[role="dialog"] button').allInnerTexts()).some(
        (b) => /switch on push/i.test(b),
      ),
  );
  await quietPage.getByRole("button", { name: "Back to alerts" }).click();
  await quietPage.waitForSelector("text=No alerts for your places right now");
  const smallC = await smallTargets(quietPage);
  note(
    `${tag} every control in the empty state is a 49px target`,
    smallC.length === 0,
    smallC.join("; "),
  );
  await quietPage.screenshot({
    path: `${SHOTS}/notifications-${name}-empty.png`,
  });
  await quiet.close();
}

/** The phone menu's row and the My Weather entry open the centre (phone only). */
async function checkPhoneEntries(browser) {
  const viewport = VIEWPORTS[0];
  const tag = "[393x852 menu]";
  state.scenario = "alerts";
  const context = await newContext(browser, viewport, true);
  const page = await context.newPage();
  await loadPlace(page);
  // The account menu: the first slot of the bottom bar (the avatar), which
  // opens upward (the phone header is not drawn over the sky).
  await page.click(ACCOUNT_TRIGGER);
  await page.getByRole("button", { name: "Notifications" }).click();
  await dialog(page).waitFor({ state: "visible", timeout: 10000 });
  await page.waitForSelector("article", { timeout: 10000 });
  note(
    `${tag} the menu's Notifications row opens the same centre, as a sheet with the alerts`,
    (await page.locator('[role="dialog"] article').count()) >= 1,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  const focus = await page.evaluate(() => {
    const a = document.activeElement;
    return a
      ? `${a.tagName.toLowerCase()}${a.closest('[data-slot="mzizi-bottom-nav"]') ? " in the bar" : ""}`
      : "none";
  });
  note(
    `${tag} closing the sheet gives focus back to the menu's trigger`,
    /summary in the bar/.test(focus),
    focus,
  );

  // My Weather, Settings tab.
  await page.click(ACCOUNT_TRIGGER);
  await page.getByRole("button", { name: "My Weather" }).click();
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Notification settings" }).click();
  await page.waitForSelector("#alert-kind-frost", { timeout: 10000 });
  note(
    `${tag} My Weather > Settings > Notification settings opens the settings (one dialog at a time)`,
    (await page.locator('[role="dialog"]').count()) === 1,
  );
  await context.close();
}

/** The centre's code does not arrive: a small message under the bell, the page keeps working. */
async function checkChunkFailure(browser) {
  const tag = "[1280x800 chunk]";
  state.scenario = "alerts";
  const context = await newContext(browser, VIEWPORTS[3], false);
  const page = await context.newPage();
  await loadPlace(page);
  await page.waitForSelector("[data-notifications-trigger]");
  // From now on no new script chunk arrives (the centre loads when first opened).
  await context.route("**/_next/static/chunks/**", (route) =>
    route.abort("failed"),
  );
  await page.locator("[data-notifications-trigger]").first().click();
  // The page has its own alerts (the frost banner): find ours by its words.
  const failed = page.locator('[role="alert"]', {
    hasText: "Notifications could not load",
  });
  await failed.waitFor({ state: "visible", timeout: 10000 });
  note(
    `${tag} a centre that cannot load shows a small message under the bell, not the error page`,
    !/Something went wrong/.test(await page.innerText("body")),
    (await failed.innerText()).slice(0, 80),
  );
  note(
    `${tag} the rest of the page keeps working`,
    (await page.locator("#current-conditions-heading").count()) === 1,
  );
  await failed.getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(300);
  note(`${tag} Close dismisses the message`, (await failed.count()) === 0);
  await context.close();
}

run(async () => {
  const browser = await chromium.launch();
  for (const viewport of VIEWPORTS) await checkViewport(browser, viewport);
  await checkPhoneEntries(browser);
  await checkChunkFailure(browser);
  await browser.close();
  finish();
});
