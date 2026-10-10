/**
 * Tests for src/proxy.ts — the lastLocation cookie must only ever be set for
 * location slugs, never for the app's own top-level routes (issue #236).
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  authkit: vi.fn(async () => ({ headers: new Headers() })),
  handleAuthkitProxy: vi.fn(() => NextResponse.next()),
}));

const { default: proxy } = await import("./proxy");

const APP_DIR = resolve(__dirname, "app");

/** Every top-level route directory under src/app, minus the dynamic slug. */
const topLevelRoutes = readdirSync(APP_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => !/^[[(_@]/.test(name));

async function lastLocationFor(path: string): Promise<string | undefined> {
  const res = await proxy(new NextRequest(`https://weather.mukoko.com${path}`));
  return res.cookies.get("lastLocation")?.value;
}

describe("proxy — lastLocation cookie", () => {
  it("finds the app's top-level routes", () => {
    expect(topLevelRoutes).toEqual(
      expect.arrayContaining(["profile", "developers", "explore", "api"]),
    );
  });

  it.each(topLevelRoutes)("never sets lastLocation for /%s", async (route) => {
    expect(await lastLocationFor(`/${route}`)).toBeUndefined();
  });

  it.each(["/profile", "/developers", "/developers/keys"])(
    "leaves lastLocation alone on %s (issue #236)",
    async (path) => {
      expect(await lastLocationFor(path)).toBeUndefined();
    },
  );

  it("sets lastLocation for a location slug", async () => {
    expect(await lastLocationFor("/harare")).toBe("harare");
  });

  it("uses the first segment of a location sub-route", async () => {
    expect(await lastLocationFor("/harare/forecast")).toBe("harare");
  });

  it("does not set lastLocation on the home page", async () => {
    expect(await lastLocationFor("/")).toBeUndefined();
  });
});

describe("WeatherLoadingScene — KNOWN_ROUTES covers every page route", () => {
  const sceneSource = readFileSync(
    resolve(__dirname, "components/weather/WeatherLoadingScene.tsx"),
    "utf-8",
  );
  const block = sceneSource.match(/KNOWN_ROUTES = new Set\(\[([\s\S]*?)\]\)/);
  const listed = new Set(
    [...(block?.[1] ?? "").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]),
  );
  const pageRoutes = topLevelRoutes.filter((route) => {
    try {
      return readdirSync(resolve(APP_DIR, route)).includes("page.tsx");
    } catch {
      return false;
    }
  });

  it.each(pageRoutes)("lists /%s", (route) => {
    expect(listed.has(route)).toBe(true);
  });
});
