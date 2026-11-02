/**
 * The app does not reload as a whole (issue #414). A page reload throws away
 * the shell, the scroll position and every open sheet, and costs a full
 * document load. Only these places may reload, each for a stated reason; a
 * new one has to be added here on purpose.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") ? [full] : [];
  });
}

const sources = files(SRC).map((f) => ({
  file: relative(SRC, f).replaceAll("\\", "/"),
  text: readFileSync(f, "utf-8"),
}));

/** Files that may call `location.reload()`, and why. */
const RELOAD_ALLOWED: Record<string, string> = {
  "components/pwa/ServiceWorkerUpdater.tsx":
    "once, when a genuinely new service worker takes control (a deploy)",
  "app/[location]/WeatherUnavailableBanner.tsx":
    "only when no onRetry is given; the dashboard always gives one",
  "lib/use-display-runtime.ts":
    "the unattended /display kiosk reloads itself every 6 hours",
};

describe("no whole-page reloads", () => {
  it("location.reload() appears only where it is allowed", () => {
    const found = sources
      .filter((s) => /location\.reload\(/.test(s.text))
      .map((s) => s.file)
      .sort();
    expect(found).toEqual(Object.keys(RELOAD_ALLOWED).sort());
  });

  it("no assignment to window.location for an in-app move", () => {
    const found = sources
      .filter((s) =>
        /(?:window\.)?location\.(?:href|pathname)\s*=(?!=)|location\.(?:assign|replace)\(/.test(
          s.text,
        ),
      )
      .map((s) => s.file);
    expect(found).toEqual([]);
  });

  it("no router.refresh() (it refetches the whole server tree)", () => {
    expect(
      sources
        .filter((s) => /router\.refresh\(/.test(s.text))
        .map((s) => s.file),
    ).toEqual([]);
  });

  it("no plain <a href> to this site's own pages (use Link)", () => {
    const own =
      /<a\s[^>]*href=(?:"https:\/\/weather\.mukoko\.com[^"]*"|\{SITE_URL\}|\{BASE_URL\})/;
    expect(sources.filter((s) => own.test(s.text)).map((s) => s.file)).toEqual(
      [],
    );
  });

  it("the dashboard's retry is a request, not a reload", () => {
    const dashboard = sources.find(
      (s) => s.file === "app/[location]/WeatherDashboard.tsx",
    )!;
    // The live-fetch controller's "Try again" (src/lib/live-fetch.ts).
    expect(dashboard.text).toContain("onRetry={live.retryNow}");
    const stage = sources.find(
      (s) => s.file === "components/weather/PlaceStage.tsx",
    )!;
    expect(stage.text).toContain("onRetry={retry}");
  });
});
