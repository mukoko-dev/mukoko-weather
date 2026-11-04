// Every modal and bottom sheet (issue #482): a visible Close at the top right,
// pull down to dismiss, and corners that follow the screen.
//
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/modal-sheet.mjs
//
// What only a browser can show, with REAL touch events (Chromium DevTools
// `Input.dispatchTouchEvent`, not synthetic DOM events): that Close is where it
// should be, 49px, and really hit-tests; that a finger on the bar or on the
// content (while it is at its top) moves the sheet and the sheet follows it; that
// a short pull springs back and a long pull or a fling closes it; that a pull on
// scrolled content scrolls it instead; that `[data-no-swipe]` is left alone; that
// reduced motion still closes; that focus, scroll lock and Escape survive; that
// the corners are the screen radius on a phone and the card radius from `sm`.
//
// The public weather API is read through the test browser (see harness.mjs);
// every write is refused. Screenshots (light and dark) go to SHOTS.
import { join } from "node:path";
import { BASE, SHOTS, chromium, proxyApi, reporter, run } from "./harness.mjs";

const { note, finish } = reporter();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PHONE = { width: 393, height: 852 };
const DIALOG = '[data-slot="dialog-content"][data-state="open"]';
const SCREEN_RADIUS_PX = 44; // --radius-screen: 2.75rem
const CARD_RADIUS_PX = 14; // --radius-card

// ── Measuring ────────────────────────────────────────────────────────────────

const measure = (page) =>
  page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    if (!dialog) return null;
    const box = dialog.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    const close = dialog.querySelector("[data-sheet-close]");
    const closeBox = close?.getBoundingClientRect();
    const closeStyle = close ? getComputedStyle(close) : null;
    let hit = false;
    if (closeBox) {
      const at = document.elementFromPoint(
        closeBox.x + closeBox.width / 2,
        closeBox.y + closeBox.height / 2,
      );
      hit = Boolean(at && close.contains(at));
    }
    return {
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      left: box.left,
      height: box.height,
      role: dialog.getAttribute("role"),
      name: dialog.getAttribute("aria-labelledby")
        ? (document.getElementById(dialog.getAttribute("aria-labelledby"))
            ?.textContent ?? "")
        : "",
      inline: dialog.style.transform,
      radius: {
        tl: parseFloat(style.borderTopLeftRadius),
        tr: parseFloat(style.borderTopRightRadius),
        bl: parseFloat(style.borderBottomLeftRadius),
      },
      scrollLocked: document.body.hasAttribute("data-scroll-locked"),
      close: closeBox && {
        w: closeBox.width,
        h: closeBox.height,
        fromTop: closeBox.top - box.top,
        fromRight: box.right - closeBox.right,
        label: close.getAttribute("aria-label"),
        hit,
        borderWidth: parseFloat(closeStyle.borderTopWidth),
        borderStyle: closeStyle.borderTopStyle,
        borderColor: closeStyle.borderTopColor,
      },
    };
  }, DIALOG);

const isOpen = async (page) => (await page.$(DIALOG)) !== null;

/** Milliseconds until the dialog is unmounted (exit animation over), or null. */
const waitClosed = async (page, ms = 1500) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((await page.$('[data-slot="dialog-content"]')) === null) {
      return Date.now() - start;
    }
    await sleep(25);
  }
  return null;
};

/** Milliseconds until Radix has released its scroll lock (it goes with the unmount), or null. */
const scrollLockReleased = async (page, ms = 1500) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const locked = await page.evaluate(() =>
      document.body.hasAttribute("data-scroll-locked"),
    );
    if (!locked) return Date.now() - start;
    await sleep(25);
  }
  return null;
};

const waitOpen = async (page) => {
  await page.waitForSelector(DIALOG, { timeout: 15000 });
  // The slide-up (300ms) has to be over before anything is measured.
  await sleep(450);
};

/** The element a finger on the content would scroll: the dialog or an inner scroller. */
const scrollerOf = (page) =>
  page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    const candidates = [dialog, ...dialog.querySelectorAll("*")];
    const found = candidates.find((el) => {
      const overflow = getComputedStyle(el).overflowY;
      return (
        (overflow === "auto" || overflow === "scroll") &&
        el.scrollHeight > el.clientHeight + 4
      );
    });
    if (!found) return null;
    found.setAttribute("data-check-scroller", "");
    return {
      isDialog: found === dialog,
      scrollHeight: found.scrollHeight,
      clientHeight: found.clientHeight,
    };
  }, DIALOG);

const scrollTopOf = (page) =>
  page.evaluate(
    () => document.querySelector("[data-check-scroller]")?.scrollTop ?? 0,
  );

// ── Real touch, through the DevTools protocol ───────────────────────────────

function finger(cdp) {
  let x = 0;
  let y = 0;
  // Events carry explicit timestamps (seconds), so the speed of a gesture is
  // what the script says it is and not what a busy dev server makes of it.
  let clock = 0;
  const send = (type, ms = 0) => {
    clock += ms / 1000;
    return cdp.send("Input.dispatchTouchEvent", {
      type,
      timestamp: clock,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
    });
  };
  return {
    async down(px, py) {
      x = px;
      y = py;
      clock = Date.now() / 1000;
      await send("touchStart");
    },
    /** Move to `py` in `steps` moves, `stepMs` of gesture time apart. */
    async to(py, { steps = 8, stepMs = 16 } = {}) {
      const from = y;
      for (let i = 1; i <= steps; i++) {
        y = from + ((py - from) * i) / steps;
        await send("touchMove", stepMs);
        await sleep(Math.min(stepMs, 6));
      }
    },
    /** One small move in both axes, as the first coarse touchmove of a real finger. */
    async nudge(dx, dy, ms = 8) {
      x += dx;
      y += dy;
      await send("touchMove", ms);
    },
    /** Lift the finger `after` ms of gesture time after the last move. */
    async up({ after = 0 } = {}) {
      await send("touchEnd", after);
    },
  };
}

/** A point on the bar that is not a control: the title row, left of Apply/Close. */
const barPoint = (box) => ({ x: 130, y: box.top + 32 });

/** Open the modal again, first closing it if a failed check left it open. */
async function reopen(page, spec) {
  if (await isOpen(page)) {
    await page.keyboard.press("Escape");
    await waitClosed(page);
  }
  await spec.open(page);
  await waitOpen(page);
}

// ── The modals ──────────────────────────────────────────────────────────────

async function openTile(page, label) {
  const tile = page.locator(`button[aria-label="${label}"]`);
  await tile.scrollIntoViewIfNeeded();
  await sleep(300);
  await tile.tap();
}

const MODALS = [
  {
    name: "My Weather",
    prepare: async (page) => {
      await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-sky-hero] summary", { timeout: 60000 });
      await sleep(1500);
    },
    open: async (page) => {
      await page.locator("[data-sky-hero] summary").first().tap();
      await sleep(200);
      await page
        .locator("button", { hasText: "My Weather" })
        .filter({ visible: true })
        .first()
        .tap();
    },
  },
  {
    name: "Wind details (DetailSheet)",
    prepare: async (page) => {
      await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('button[aria-label="Wind details"]', {
        timeout: 60000,
      });
      await sleep(1500);
    },
    open: (page) => openTile(page, "Wind details"),
  },
  {
    name: "Air quality",
    open: (page) => openTile(page, "Air quality details"),
    prepare: async (page) => {
      await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('button[aria-label="Air quality details"]', {
        timeout: 60000,
      });
      await sleep(1500);
    },
  },
  {
    name: "My activities (advice sheet)",
    // The cards the sheet scrolls to and focuses.
    cardSelector: '[id^="activity-card-box-"]',
    prepare: async (page) => {
      // The advice sheet opens from the Community lane, which shows once an
      // activity is picked: pick two in My Weather (which exercises it too).
      await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-sky-hero] summary", { timeout: 60000 });
      await sleep(1500);
      await page.locator("[data-sky-hero] summary").first().tap();
      await sleep(200);
      await page
        .locator("button", { hasText: "My Weather" })
        .filter({ visible: true })
        .first()
        .tap();
      await waitOpen(page);
      await page.getByRole("tab", { name: "Activities" }).tap();
      await sleep(800);
      const cards = page.locator(`${DIALOG} button[aria-pressed]`);
      await cards.nth(0).tap();
      await cards.nth(1).tap();
      await sleep(200);
      await page
        .locator(`${DIALOG} button`, { hasText: /^(Done|Apply)$/ })
        .tap();
      await waitClosed(page);
      await page.waitForSelector(
        'button[aria-label="Open all activity advice"]',
        { timeout: 60000 },
      );
      await sleep(1500);
    },
    open: async (page) => {
      // A lane row's own hit area (it sits over the whole-card one). The
      // SECOND activity, so the sheet has to scroll to its card.
      const button = page.locator('button[aria-label$=": open advice"]').nth(1);
      await button.scrollIntoViewIfNeeded();
      await sleep(300);
      await button.tap();
    },
  },
  {
    name: "Report weather",
    prepare: async (page) => {
      await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-sky-hero]", { timeout: 60000 });
      await sleep(1500);
    },
    open: async (page) => {
      // The reports section is lazy: scroll to its wrapper, let it mount.
      const section = page.locator('[data-lazy-section="community-reports"]');
      await section.scrollIntoViewIfNeeded();
      const button = section.locator("button", { hasText: "Report Weather" });
      await button.first().waitFor({ state: "visible", timeout: 30000 });
      await button.first().scrollIntoViewIfNeeded();
      await button.first().tap();
    },
  },
];

async function checkModal(browser, spec, { reduced = false } = {}) {
  const tag = `${spec.name}${reduced ? " [reduced motion]" : ""}`;
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    reducedMotion: reduced ? "reduce" : "no-preference",
  });
  await proxyApi(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const touch = finger(cdp);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await spec.prepare(page);
  await spec.open(page);
  await waitOpen(page);
  const base = await measure(page);
  if (!base) {
    note(`${tag}: opens`, false);
    await context.close();
    return;
  }
  note(
    `${tag}: opens as a labelled dialog`,
    base.role === "dialog" && base.name.length > 0,
    `"${base.name}"`,
  );

  if (!reduced) {
    // ── 1. Close ───────────────────────────────────────────────────────────
    const c = base.close;
    note(
      `${tag}: a Close control is in the top bar`,
      Boolean(c) && c.label === "Close",
    );
    note(
      `${tag}: Close is 49px (the Bundu floor)`,
      Boolean(c) && c.w >= 48.9 && c.h >= 48.9,
      c && `${c.w.toFixed(1)} x ${c.h.toFixed(1)}`,
    );
    note(
      `${tag}: Close is at the top right, 7px from the corner`,
      Boolean(c) &&
        Math.abs(c.fromTop - 7) <= 1 &&
        Math.abs(c.fromRight - 7) <= 1,
      c &&
        `from top ${c.fromTop.toFixed(1)}, from right ${c.fromRight.toFixed(1)}`,
    );
    note(`${tag}: Close really hit-tests (nothing covers it)`, Boolean(c?.hit));
    note(
      `${tag}: Close has the hairline border`,
      Boolean(c) &&
        c.borderStyle === "solid" &&
        c.borderWidth > 0 &&
        c.borderWidth <= 1 &&
        c.borderColor !== "rgba(0, 0, 0, 0)",
      c && `${c.borderWidth}px ${c.borderColor}`,
    );
    note(
      `${tag}: the corners are the screen radius, flush at the bottom`,
      Math.abs(base.radius.tl - SCREEN_RADIUS_PX) < 0.5 &&
        Math.abs(base.radius.tr - SCREEN_RADIUS_PX) < 0.5 &&
        base.radius.bl === 0,
      `top ${base.radius.tl}/${base.radius.tr}px, bottom ${base.radius.bl}px`,
    );
    note(
      `${tag}: the page is scroll-locked while it is open`,
      base.scrollLocked,
    );
    note(
      `${tag}: focus moves into the dialog when it opens`,
      await page.evaluate(
        (selector) =>
          document.querySelector(selector).contains(document.activeElement),
        DIALOG,
      ),
    );

    // One control is called "Close" (the bar's); a Close drawn at the foot of
    // a sheet is named apart ("Close sheet"), so a screen reader does not read
    // two identical buttons.
    const names = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector);
      return [...dialog.querySelectorAll("button")].map(
        (b) => b.getAttribute("aria-label") ?? b.textContent.trim(),
      );
    }, DIALOG);
    note(
      `${tag}: exactly one control is named "Close"`,
      names.filter((n) => n === "Close").length === 1,
      `buttons: ${names.filter((n) => /close/i.test(n)).join(" | ")}`,
    );

    // The pinned bar covers the top of the scroller: what is scrolled or
    // focused into view must land BELOW it, not under it.
    if (spec.cardSelector) {
      const pad = await page.evaluate((selector) => {
        const dialog = document.querySelector(selector);
        const bar = dialog.querySelector('[data-slot="dialog-bar"]');
        return {
          scrollPaddingTop: parseFloat(
            getComputedStyle(dialog).scrollPaddingTop,
          ),
          barHeight: bar.getBoundingClientRect().height,
        };
      }, DIALOG);
      note(
        `${tag}: the scroller's scroll padding is the bar's height`,
        Math.abs(pad.scrollPaddingTop - pad.barHeight) <= 0.5,
        `scroll-padding-top ${pad.scrollPaddingTop}px, bar ${pad.barHeight}px`,
      );
      const below = (pick, card) =>
        page.evaluate(
          ({ dialogSelector, cardSelector, pick }) => {
            const dialog = document.querySelector(dialogSelector);
            const bar = dialog
              .querySelector('[data-slot="dialog-bar"]')
              .getBoundingClientRect();
            const cards = [...dialog.querySelectorAll(cardSelector)];
            const el =
              pick === "active"
                ? document.activeElement
                : cards[pick === "first" ? 0 : cards.length - 1];
            return {
              isCard: cards.includes(el),
              gapBelowBar: el.getBoundingClientRect().top - bar.bottom,
              scrollTop: dialog.scrollTop,
            };
          },
          { dialogSelector: DIALOG, cardSelector: card, pick },
        );
      // On open the sheet scrolls to the tapped activity's card and focuses it.
      const opened = await below("active", spec.cardSelector);
      note(
        `${tag}: the card the sheet opened on is below the bar, not under it`,
        opened.isCard && opened.scrollTop > 0 && opened.gapBelowBar >= -0.5,
        `scrolled ${opened.scrollTop.toFixed(0)}px, card ${opened.gapBelowBar.toFixed(1)}px below the bar`,
      );
      // Focus (Tab, Shift+Tab, focus()) scrolls an element above the view to
      // the top edge: also below the bar.
      await page.evaluate((selector) => {
        const dialog = document.querySelector(selector);
        dialog.scrollTop = dialog.scrollHeight;
      }, DIALOG);
      await sleep(150);
      await page.evaluate(
        ({ dialogSelector, cardSelector }) => {
          document
            .querySelector(dialogSelector)
            .querySelector(cardSelector)
            .focus();
        },
        { dialogSelector: DIALOG, cardSelector: spec.cardSelector },
      );
      await sleep(250);
      const focused = await below("first", spec.cardSelector);
      note(
        `${tag}: a card focused from below scrolls to just under the bar`,
        focused.gapBelowBar >= -0.5 && focused.gapBelowBar <= 40,
        `card ${focused.gapBelowBar.toFixed(1)}px below the bar`,
      );
      // Control: take the padding away and the same focus puts the card UNDER
      // the bar, so the check above can fail (it is not passing by luck).
      await page.evaluate((selector) => {
        const dialog = document.querySelector(selector);
        dialog.style.scrollPaddingTop = "0px";
        dialog.scrollTop = dialog.scrollHeight;
      }, DIALOG);
      await sleep(150);
      await page.evaluate(
        ({ dialogSelector, cardSelector }) => {
          document
            .querySelector(dialogSelector)
            .querySelector(cardSelector)
            .focus();
        },
        { dialogSelector: DIALOG, cardSelector: spec.cardSelector },
      );
      await sleep(250);
      const without = await below("first", spec.cardSelector);
      note(
        `${tag}: control: without the padding the same focus hides the card under the bar`,
        without.gapBelowBar < 0,
        `card ${without.gapBelowBar.toFixed(1)}px below the bar`,
      );
      await page.evaluate((selector) => {
        const dialog = document.querySelector(selector);
        dialog.style.scrollPaddingTop = "";
        dialog.scrollTop = 0;
      }, DIALOG);
      await sleep(150);
    }

    // Screenshots, light then dark.
    const slug = spec.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    await page.screenshot({ path: join(SHOTS, `modal-${slug}-light.png`) });
    await page.emulateMedia({ colorScheme: "dark" });
    await sleep(500);
    await page.screenshot({ path: join(SHOTS, `modal-${slug}-dark.png`) });
    await page.emulateMedia({ colorScheme: "light" });
    await sleep(300);

    // ── 2. Keyboard: Close is reachable and Enter closes ───────────────────
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(
        () => document.activeElement?.hasAttribute("data-sheet-close") ?? false,
      );
    }
    note(`${tag}: Close is reachable by keyboard`, reached);
    if (reached) {
      const ring = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement);
        return { width: parseFloat(s.outlineWidth), style: s.outlineStyle };
      });
      note(
        `${tag}: Close shows a focus ring`,
        ring.style !== "none" && ring.width >= 2,
        `${ring.width}px ${ring.style}`,
      );
      await page.keyboard.press("Enter");
      note(
        `${tag}: Enter on Close closes it`,
        (await waitClosed(page)) !== null,
      );
    }
    const released = await scrollLockReleased(page);
    note(
      `${tag}: scroll lock is released after closing`,
      released !== null,
      released !== null ? `${released}ms after unmount` : "still locked",
    );

    // ── 3. A tap on Close, and Escape ──────────────────────────────────────
    await reopen(page, spec);
    const m = await measure(page);
    await page.touchscreen.tap(m.right - 7 - 24.5, m.top + 7 + 24.5);
    note(`${tag}: a tap on Close closes it`, (await waitClosed(page)) !== null);
    await reopen(page, spec);
    await page.keyboard.press("Escape");
    note(`${tag}: Escape closes it`, (await waitClosed(page)) !== null);
  }

  // ── 4. Pull down from the bar: follows, springs back ─────────────────────
  await reopen(page, spec);
  const start = await measure(page);
  const bar = barPoint(start);
  await touch.down(bar.x, bar.y);
  await touch.to(bar.y + 70, { steps: 10 });
  await sleep(60);
  const mid = await measure(page);
  note(
    `${tag}: the sheet follows the finger down (bar)`,
    mid && Math.abs(mid.top - start.top - 70) <= 4,
    mid &&
      `finger moved 70px, sheet moved ${(mid.top - start.top).toFixed(1)}px`,
  );
  if (!reduced && mid) {
    const slug = spec.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    await page.screenshot({ path: join(SHOTS, `modal-${slug}-mid-pull.png`) });
  }
  await touch.up({ after: 150 });
  await sleep(reduced ? 80 : 450);
  const back = await measure(page);
  note(
    `${tag}: a 70px pull springs back and stays open`,
    back && Math.abs(back.top - start.top) <= 1 && back.inline === "",
    back &&
      `top ${back.top.toFixed(1)} (was ${start.top.toFixed(1)}), inline transform "${back.inline}"`,
  );

  // ── 5. Pull past the distance closes it ──────────────────────────────────
  await touch.down(bar.x, bar.y);
  await touch.to(bar.y + 240, { steps: 14 });
  await touch.up({ after: 150 }); // rested before lifting: no fling
  const long = await waitClosed(page, 1500);
  note(
    `${tag}: a 240px pull closes it`,
    long !== null,
    long !== null ? `gone ${long}ms after release` : "still open",
  );
  const releasedAfterPull = await scrollLockReleased(page);
  note(
    `${tag}: scroll lock is released after a pull`,
    releasedAfterPull !== null,
    releasedAfterPull !== null
      ? `${releasedAfterPull}ms after unmount`
      : "still locked",
  );
  if (reduced && long !== null) {
    note(`${tag}: closes at once, nothing slides`, long <= 150, `${long}ms`);
  }
  // ── 6. Reopen: nothing left over from the pull ───────────────────────────
  await reopen(page, spec);
  const again = await measure(page);
  note(
    `${tag}: reopens clean (no leftover offset)`,
    again && Math.abs(again.top - start.top) <= 1 && again.inline === "",
    again && `top ${again.top.toFixed(1)}`,
  );

  if (!reduced) {
    // ── 7. A fling from a short pull ─────────────────────────────────────────
    await touch.down(bar.x, bar.y);
    await touch.to(bar.y + 60, { steps: 3, stepMs: 12 });
    await touch.up({ after: 6 });
    note(
      `${tag}: a fast 60px fling closes it`,
      (await waitClosed(page, 1500)) !== null,
    );
    await reopen(page, spec);

    // ── 7b. A jittery first move must not kill a real pull ───────────────────
    // The first touchmove of a real finger is coarse: 3px across, 2 down. It
    // decides nothing; the pull that follows must still move the sheet.
    const jitterStart = await measure(page);
    const jitterBar = barPoint(jitterStart);
    await touch.down(jitterBar.x, jitterBar.y);
    await touch.nudge(3, 2);
    await touch.to(jitterBar.y + 2 + 70, { steps: 10 });
    await sleep(60);
    const jitterMid = await measure(page);
    note(
      `${tag}: a jittery first move (3px across, 2 down) does not kill a pull (bar)`,
      Math.abs(jitterMid.top - jitterStart.top - 72) <= 6,
      `finger moved 72px, sheet moved ${(jitterMid.top - jitterStart.top).toFixed(1)}px`,
    );
    await touch.up({ after: 150 });
    await sleep(450);
    // Content pull: from the top of the content (a sheet may have scrolled).
    await scrollerOf(page);
    await page.evaluate(() => {
      const el = document.querySelector("[data-check-scroller]");
      if (el) el.scrollTop = 0;
    });
    await sleep(150);
    const jitterContent = await measure(page);
    await touch.down(300, jitterContent.top + 120);
    await touch.nudge(3, 2);
    await touch.to(jitterContent.top + 120 + 2 + 70, { steps: 10 });
    await sleep(60);
    const jitterContentMid = await measure(page);
    note(
      `${tag}: a jittery first move does not kill a pull from the content (touch)`,
      Math.abs(jitterContentMid.top - jitterContent.top - 72) <= 8,
      `finger moved 72px, sheet moved ${(jitterContentMid.top - jitterContent.top).toFixed(1)}px`,
    );
    await touch.up({ after: 150 });
    await sleep(450);

    // ── 8. From the content while it is at its top ───────────────────────────
    const scroller = await scrollerOf(page);
    // Some sheets scroll to a card on open: start from the top of the content.
    await page.evaluate(() => {
      const el = document.querySelector("[data-check-scroller]");
      if (el) el.scrollTop = 0;
    });
    await sleep(150);
    const top = await measure(page);
    const contentY = top.top + 120;
    await touch.down(300, contentY);
    await touch.to(contentY + 70, { steps: 10 });
    await sleep(60);
    const contentMid = await measure(page);
    note(
      `${tag}: the sheet follows a finger on the content at its top`,
      contentMid && Math.abs(contentMid.top - top.top - 70) <= 8,
      contentMid &&
        `sheet moved ${(contentMid.top - top.top).toFixed(1)}px for a 70px pull`,
    );
    await touch.up({ after: 150 });
    await sleep(450);

    // ── 9. Scrolled content scrolls instead; the bar still pulls ─────────────
    if (scroller) {
      await page.evaluate(() => {
        document.querySelector("[data-check-scroller]").scrollTop = 160;
      });
      await sleep(100);
      const before = await scrollTopOf(page);
      const sheetBefore = await measure(page);
      await touch.down(300, sheetBefore.top + 200);
      await touch.to(sheetBefore.top + 330, { steps: 10 });
      await sleep(60);
      const duringScrolled = await measure(page);
      await touch.up({ after: 150 });
      await sleep(450);
      const after = await scrollTopOf(page);
      note(
        `${tag}: a pull on scrolled content scrolls it and leaves the sheet alone`,
        Math.abs(duringScrolled.top - sheetBefore.top) <= 1 && after < before,
        `scrollTop ${before} -> ${after}, sheet moved ${(duringScrolled.top - sheetBefore.top).toFixed(1)}px`,
      );
      await page.evaluate(() => {
        document.querySelector("[data-check-scroller]").scrollTop = 160;
      });
      await sleep(100);
      const barBox = await measure(page);
      const p = barPoint(barBox);
      await touch.down(p.x, p.y);
      await touch.to(p.y + 70, { steps: 10 });
      await sleep(60);
      const barMid = await measure(page);
      note(
        `${tag}: the bar still pulls the sheet while the content is scrolled`,
        Math.abs(barMid.top - barBox.top - 70) <= 4,
        `sheet moved ${(barMid.top - barBox.top).toFixed(1)}px`,
      );
      await touch.up({ after: 150 });
      await sleep(450);
    } else {
      note(
        `${tag}: (content does not scroll at this size, scrolled-content checks skipped)`,
        true,
      );
    }

    // ── 10. [data-no-swipe] is left alone ───────────────────────────────────
    const marked = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector);
      // Everything under the bar is a no-swipe area for this check.
      let next = dialog.querySelector(
        '[data-slot="dialog-bar"]',
      ).nextElementSibling;
      if (!next) return false;
      for (; next; next = next.nextElementSibling) {
        next.setAttribute("data-no-swipe", "");
      }
      return true;
    }, DIALOG);
    if (marked) {
      const t = await measure(page);
      await page.evaluate(() => {
        const s = document.querySelector("[data-check-scroller]");
        if (s) s.scrollTop = 0;
      });
      await touch.down(300, t.top + 120);
      await touch.to(t.top + 220, { steps: 8 });
      await sleep(60);
      const m2 = await measure(page);
      note(
        `${tag}: a pull that starts in [data-no-swipe] does not move the sheet`,
        Math.abs(m2.top - t.top) <= 1,
        `sheet moved ${(m2.top - t.top).toFixed(1)}px`,
      );
      await touch.up({ after: 150 });
      await sleep(300);
    }
  }

  note(`${tag}: no page errors`, errors.length === 0, errors[0]?.slice(0, 120));
  await context.close();
}

async function checkDesktop(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await proxyApi(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[aria-label="Wind details"]', {
    timeout: 60000,
  });
  await sleep(1500);
  await page
    .locator('button[aria-label="Wind details"]')
    .scrollIntoViewIfNeeded();
  await page.locator('button[aria-label="Wind details"]').click();
  await waitOpen(page);
  const m = await measure(page);
  note(
    "Desktop (1280px): a centred dialog with the card radius",
    Math.abs(m.radius.tl - CARD_RADIUS_PX) < 0.5 &&
      Math.abs(m.radius.bl - CARD_RADIUS_PX) < 0.5 &&
      Math.abs((m.left + m.right) / 2 - 640) <= 1,
    `radius ${m.radius.tl}/${m.radius.bl}px, centre ${((m.left + m.right) / 2).toFixed(1)}`,
  );
  note(
    "Desktop: Close is still at the top right and 49px",
    m.close &&
      m.close.w >= 48.9 &&
      m.close.hit &&
      Math.abs(m.close.fromTop - 7) <= 1 &&
      Math.abs(m.close.fromRight - 7) <= 1,
  );
  await page.screenshot({ path: join(SHOTS, "modal-wind-desktop.png") });
  // A mouse drag on the bar must not move a centred dialog.
  await page.mouse.move(m.left + 100, m.top + 32);
  await page.mouse.down();
  await page.mouse.move(m.left + 100, m.top + 232, { steps: 8 });
  const dragged = await measure(page);
  await page.mouse.up();
  note(
    "Desktop: dragging the bar does not move the dialog",
    Math.abs(dragged.top - m.top) <= 1,
  );
  await page.locator(`${DIALOG} [data-sheet-close]`).click();
  note("Desktop: clicking Close closes it", (await waitClosed(page)) !== null);
  await context.close();
}

/**
 * The `sm` breakpoint, from both sides: the classes (sheet below it, centred
 * dialog from it) and the pull-down script (a phone only) must agree at the
 * pixel. 639px is a sheet, 640px is a centred dialog that cannot be pulled.
 */
async function checkBreakpoint(browser) {
  const context = await browser.newContext({
    viewport: { width: 639, height: 800 },
  });
  await proxyApi(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/harare`, { waitUntil: "domcontentloaded" });
  const wind = page.locator('button[aria-label="Wind details"]');
  await wind.waitFor({ state: "attached", timeout: 60000 });
  await sleep(1500);
  const openWind = async () => {
    await wind.scrollIntoViewIfNeeded();
    await wind.click();
    await waitOpen(page);
  };
  const pullBar = async (box) => {
    await page.mouse.move(box.left + 100, box.top + 32);
    await page.mouse.down();
    await page.mouse.move(box.left + 100, box.top + 232, { steps: 8 });
    const moved = await measure(page);
    await page.mouse.up();
    return moved.top - box.top;
  };

  await openWind();
  const narrow = await measure(page);
  note(
    "639px: a docked sheet (screen-radius top corners, bottom edge at the viewport bottom)",
    Math.abs(narrow.radius.tl - SCREEN_RADIUS_PX) < 0.5 &&
      Math.abs(narrow.bottom - 800) <= 1,
    `radius ${narrow.radius.tl}px, bottom ${narrow.bottom}px`,
  );
  const narrowMoved = await pullBar(narrow);
  note(
    "639px: a mouse pull on the bar moves the sheet",
    Math.abs(narrowMoved - 200) <= 6,
    `moved ${narrowMoved.toFixed(1)}px for a 200px drag`,
  );
  await sleep(500);
  if (await isOpen(page)) await page.keyboard.press("Escape");
  await waitClosed(page);

  await page.setViewportSize({ width: 640, height: 800 });
  await sleep(400);
  await openWind();
  const wide = await measure(page);
  note(
    "640px: a centred dialog with the card radius",
    Math.abs(wide.radius.tl - CARD_RADIUS_PX) < 0.5 &&
      Math.abs((wide.left + wide.right) / 2 - 320) <= 1 &&
      Math.abs(wide.bottom - 800) > 1,
    `radius ${wide.radius.tl}px, centre ${((wide.left + wide.right) / 2).toFixed(1)}`,
  );
  const wideMoved = await pullBar(wide);
  note(
    "640px: a mouse pull on the bar does not move the dialog",
    Math.abs(wideMoved) <= 1,
    `moved ${wideMoved.toFixed(1)}px`,
  );
  await context.close();
}

async function checkInstallPrompt(browser) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  await proxyApi(context);
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(`${BASE}/about`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main", { timeout: 60000 });
  // Real time for hydration (the prompt listens for beforeinstallprompt from an
  // effect); only then the page's clock is moved.
  await sleep(8000);
  await page.clock.runFor(1500);
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    event.prompt = () => Promise.resolve();
    event.userChoice = Promise.resolve({
      outcome: "dismissed",
      platform: "web",
    });
    window.dispatchEvent(event);
  });
  await page.clock.runFor(61000);
  const shown = await page.waitForSelector(DIALOG, { timeout: 8000 }).then(
    () => true,
    () => false,
  );
  note("Install prompt: opens as a sheet", shown);
  if (shown) {
    await page.clock.runFor(1000);
    const m = await measure(page);
    note(
      "Install prompt: full width on a phone, Close at the top right, screen-radius corners",
      Math.abs(m.left) <= 1 &&
        Math.abs(m.right - PHONE.width) <= 1 &&
        m.close?.hit &&
        Math.abs(m.close.fromTop - 7) <= 1 &&
        Math.abs(m.radius.tl - SCREEN_RADIUS_PX) < 0.5,
      `left ${m.left}, right ${m.right}, radius ${m.radius.tl}px`,
    );
    // Its name is in the bar (no second title and no blank strip below it),
    // and it opens on the primary action, not on Close.
    const named = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector);
      const bar = dialog.querySelector('[data-slot="dialog-bar"]');
      return {
        barTitle: bar.querySelector('[data-slot="dialog-title"]')?.textContent,
        titles: dialog.querySelectorAll('[data-slot="dialog-title"]').length,
        focused: document.activeElement?.textContent?.trim(),
      };
    }, DIALOG);
    note(
      "Install prompt: the name is the bar's title, and the only title",
      named.barTitle === "Install mukoko weather" && named.titles === 1,
      `"${named.barTitle}", ${named.titles} title element(s)`,
    );
    note(
      'Install prompt: it opens with focus on "Install app", not on Close',
      named.focused === "Install app",
      `focused: "${named.focused}"`,
    );
    await page.screenshot({
      path: join(SHOTS, "modal-install-prompt-light.png"),
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.clock.runFor(500);
    await page.screenshot({
      path: join(SHOTS, "modal-install-prompt-dark.png"),
    });
    await page.touchscreen.tap(m.right - 31.5, m.top + 31.5);
    await page.clock.runFor(1000);
    note("Install prompt: a tap on Close dismisses it", !(await isOpen(page)));
  }
  await context.close();
}

run(async () => {
  const browser = await chromium.launch();
  for (const spec of MODALS) await checkModal(browser, spec);
  // The same pull, with the system asking for reduced motion.
  await checkModal(browser, MODALS[1], { reduced: true });
  await checkDesktop(browser);
  await checkBreakpoint(browser);
  await checkInstallPrompt(browser);
  await browser.close();
  finish();
});
