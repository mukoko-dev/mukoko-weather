import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// Colour transitions in flight give axe blended colours (contrast 1.04 once);
// audit only after they finish.
const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().length === 0);

const signIn = async (page: Page, as = "owner") => {
  await page.goto(`/auth/signin?as=${as}`);
  await expect(
    page.getByRole("heading", { name: "Station console", level: 1 }),
  ).toBeVisible();
};

async function register(
  page: Page,
  name: string,
  type: "Digital" | "Analog" = "Digital",
) {
  await page.getByLabel("Station name").fill(name);
  await page.getByLabel("Latitude").fill("-18.18");
  await page.getByLabel("Longitude").fill("31.55");
  await page
    .getByText(
      type === "Digital"
        ? "Digital (uploads automatically)"
        : "Analog (manual readings)",
    )
    .click();
  await page.getByRole("button", { name: "Register station" }).click();
  await expect(page.locator("#credentials")).toBeVisible();
}

test.describe("anonymous landing", () => {
  test("shows the landing page with landmarks and a sign-in call to action", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "mukoko weather stations",
    );
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Sign in to register your station" }),
    ).toHaveAttribute("href", "/auth/signin");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
  });

  test("has zero axe violations in light and dark", async ({ page }) => {
    await page.goto("/");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await settled(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("draws the mineral ribbon vertically on the left edge", async ({
    page,
  }) => {
    await page.goto("/");
    const strip = page.locator('[data-slot="mineral-strip"]');
    const box = (await strip.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBe(0);
    expect(box.width).toBeLessThanOrEqual(8);
    expect(box.height).toBe(viewport.height);
    await expect(strip.locator("span")).toHaveCount(7);
  });

  test("does not scroll sideways on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test("the BFF answers 401 JSON to anonymous callers, with no-store", async ({
    request,
  }) => {
    const res = await request.get("/api/stations");
    expect(res.status()).toBe(401);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["x-robots-tag"]).toContain("noindex");
  });

  test("unknown pages get the branded 404", async ({ page }) => {
    const res = await page.goto("/nope");
    expect(res?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
  });
});

test.describe("signed in console", () => {
  test("sign-in shows the console, sign-out returns to the landing page", async ({
    page,
  }) => {
    await signIn(page);
    await expect(
      page.getByText("Signed in as owner@example.test"),
    ).toBeVisible();
    await page.locator('[data-slot="account-menu"] summary').click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.getByRole("link", { name: "Sign in to register your station" }),
    ).toBeVisible();
  });

  test("registers a station: one-time credentials, WU and Ecowitt setup, listed and remembered", async ({
    page,
  }) => {
    await signIn(page, "reg");
    await register(page, "Marondera High");
    const creds = page.locator("#credentials");
    const id = (await creds.locator("[data-cred-id]").textContent())!;
    const key = (await creds.locator("[data-cred-key]").textContent())!;
    expect(id).toMatch(/^mws-[a-f0-9]{8}$/);
    expect(key.length).toBeGreaterThan(20);
    await expect(creds).toContainText(
      "Wunderground protocol: server weather.mukoko.com, path /api/py/stations/ingest",
    );
    await expect(creds).toContainText(`PASSKEY = ${id}:<your ingest key>`);

    // The key is in the browser store (as before) and never in the list text.
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("mws-console-stations") ?? "[]"),
    );
    expect(stored).toEqual([
      { stationId: id, key, name: "Marondera High", stationType: "digital" },
    ]);
    const card = page.locator("[data-station]", { hasText: id });
    await expect(card).toContainText("Marondera High");
    await expect(card).toContainText("Owned by you");
    await expect(card).not.toContainText(key);

    await page.getByRole("button", { name: "I have saved them" }).click();
    await expect(creds).toBeHidden();
    expect(await page.locator("body").textContent()).not.toContain(key);

    // A reload lists the station from the server (owner-based), not only localStorage.
    await page.evaluate(() => localStorage.removeItem("mws-console-stations"));
    await page.reload();
    await expect(page.locator("[data-station]", { hasText: id })).toBeVisible();
  });

  test("validates the form without calling the server", async ({ page }) => {
    await signIn(page, "val");
    let posts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST") posts++;
    });
    await page.getByLabel("Station name").fill("A");
    await page.getByRole("button", { name: "Register station" }).click();
    await expect(page.locator("#console-error")).toContainText(/name/i);
    expect(posts).toBe(0);
  });

  test("logs a manual reading and shows status; rejects out-of-range values", async ({
    page,
  }) => {
    await signIn(page, "manual");
    await register(page, "Farm gauge", "Analog");
    await page.getByRole("button", { name: "I have saved them" }).click();
    const card = page.locator("[data-station]").first();
    await expect(card).toContainText("No readings yet");

    await card.getByLabel("Temperature (°C)").fill("21.5");
    await card.getByLabel("Rain (mm)").fill("3");
    await card.getByRole("button", { name: "Log reading" }).click();
    await expect(card.getByRole("status")).toContainText(
      "Saved. 2 measurement(s) accepted",
    );
    await expect(card).toContainText("air temperature celsius: 21.5");
    await expect(card).toContainText("Last reading");

    await card.getByLabel("Humidity (%)").fill("150");
    await card.getByRole("button", { name: "Log reading" }).click();
    await expect(card.getByRole("status")).toContainText(
      "humidityPercent must be a number between 0 and 100",
    );
  });

  test("a legacy key-only station saved in this browser still works", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("mws-console-stations")) {
        localStorage.setItem(
          "mws-console-stations",
          JSON.stringify([
            {
              stationId: "mws-00000001",
              key: "legacy-demo-key",
              name: "Demo school (legacy key)",
              stationType: "manual",
            },
          ]),
        );
      }
    });
    await signIn(page, "legacy");
    const card = page.locator("[data-station]", { hasText: "mws-00000001" });
    await expect(card).toContainText("Key on this device");
    await expect(card.getByRole("button", { name: "Rotate key" })).toBeHidden();
    await card.getByLabel("Wind (km/h)").fill("12");
    await card.getByRole("button", { name: "Log reading" }).click();
    await expect(card.getByRole("status")).toContainText("Saved");
    await page.evaluate(() =>
      localStorage.setItem("mws-console-stations", "[]"),
    );
    await card.getByRole("button", { name: "Remove from this device" }).click();
    await expect(page.locator("[data-station]")).toHaveCount(0);
    await expect(page.getByText("No stations yet")).toBeVisible();
  });

  test("rotating a key shows the new key once", async ({ page }) => {
    await signIn(page, "rot");
    await register(page, "Rotating");
    const oldKey = (await page.locator("[data-cred-key]").textContent())!;
    await page.getByRole("button", { name: "I have saved them" }).click();
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Rotate key" }).click();
    await expect(page.locator("#credentials")).toBeVisible();
    expect(await page.locator("[data-cred-key]").textContent()).not.toBe(
      oldKey,
    );
  });

  test("stations are private to their owner, and cross-origin writes are refused", async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    await signIn(page, "alice");
    await register(page, "Alice only");
    const id = (await page.locator("[data-cred-id]").textContent())!;

    const bob = await browser.newContext({ baseURL: baseURL! });
    await (await bob.newPage()).goto("/auth/signin?as=bob");
    const list = await bob.request.get("/api/stations");
    expect((await list.json()).stations).toEqual([]);
    expect((await bob.request.get(`/api/stations/${id}`)).status()).toBe(404);
    await bob.close();

    const cross = await page.request.post("/api/stations", {
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      data: { name: "x", lat: 0, lon: 0, stationType: "digital" },
    });
    expect(cross.status()).toBe(403);
    expect((await request.get("/api/stations")).status()).toBe(401);
  });

  test("the register response is no-store and unframed", async ({ page }) => {
    await signIn(page, "hdr");
    const res = await page.request.post("/api/stations", {
      data: { name: "Header check", lat: 1, lon: 1, stationType: "digital" },
    });
    expect(res.status()).toBe(201);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
  });

  test("is axe clean and the theme switch sets class-based dark mode", async ({
    page,
  }) => {
    await signIn(page, "a11y");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.locator('[data-slot="account-menu"] summary').click();
    await page.getByText("Dark", { exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem("mws-theme"))).toBe(
      "dark",
    );
    await settled(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("buttons are at least 44px tall on a touch device", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await browser.newContext({
      baseURL: baseURL!,
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await ctx.newPage();
    await page.goto("/auth/signin?as=touch");
    await expect(
      page.getByRole("heading", { name: "Station console", level: 1 }),
    ).toBeVisible();
    for (const name of ["Register station", "Use GPS"]) {
      const box = (await page.getByRole("button", { name }).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await ctx.close();
  });

  test("honours reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, "motion");
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
  });
});
