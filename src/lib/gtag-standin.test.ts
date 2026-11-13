import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  BURST_ITERATIONS,
  GTAG_HOST,
  REAL_GTAG,
  gtagBytes,
  gtagStandInSource,
  routeGtag,
  serveGtag,
} from "../../scripts/browser-check/gtag-standin.mjs";

// The first-screen lab harness (scripts/browser-check/first-screen.mjs) serves
// a generated stand-in for Google's gtag.js so the page pays for the tag the
// way a phone does (issue #551). These tests keep the stand-in the size of the
// real tag, deterministic and valid, and the harness pointed at the host the
// app loads the tag from. They do not run a browser.

describe("the gtag.js stand-in is the size of the real tag", () => {
  it("decodes to the real file's size, within 2%", () => {
    const decoded = Buffer.byteLength(gtagStandInSource());
    expect(
      Math.abs(decoded - REAL_GTAG.decoded) / REAL_GTAG.decoded,
    ).toBeLessThan(0.02);
  });

  it("gzips to about the real file's wire size (within 8%)", () => {
    const gzip = zlib.gzipSync(gtagStandInSource(), { level: 6 }).length;
    expect(Math.abs(gzip - REAL_GTAG.gzip) / REAL_GTAG.gzip).toBeLessThan(0.08);
  });

  it("is deterministic, and a different seed is different bytes", () => {
    expect(gtagStandInSource()).toBe(gtagStandInSource());
    expect(gtagStandInSource({ seed: 1, decodedBytes: 20_000 })).not.toBe(
      gtagStandInSource({ seed: 2, decodedBytes: 20_000 }),
    );
  });

  it("is valid JavaScript that runs without touching anything but window", () => {
    const window: Record<string, unknown> = {};
    const timers: Array<() => void> = [];
    vm.runInNewContext(gtagStandInSource({ burst: 1000 }), {
      window,
      setTimeout: (fn: () => void) => timers.push(fn),
    });
    expect(window.__gtagStandIn).toBe(true);
    // The second burst of work runs from a timer, as the real tag's does.
    expect(timers).toHaveLength(1);
    const first = window.__gtagStandInSum;
    timers[0]();
    expect(window.__gtagStandInSum).toBe(first);
  });

  it("does two bursts of work, each about 190 ms at 4x CPU, as the real tag did", () => {
    // 36 million iterations is about 57 ms of arithmetic, 190 ms at 4x CPU.
    // Change the constant only with a measurement (see the header).
    expect(BURST_ITERATIONS).toBe(36_000_000);
    expect(gtagStandInSource()).toContain(`burst(${BURST_ITERATIONS})`);
  });
});

describe("the harness asks for the host the app loads the tag from", () => {
  it("GoogleAnalytics.tsx loads gtag.js from GTAG_HOST", () => {
    const source = readFileSync(
      resolve(__dirname, "../components/analytics/GoogleAnalytics.tsx"),
      "utf-8",
    );
    expect(source).toContain(`https://${GTAG_HOST}/gtag/js?id=`);
  });

  it("redirects only that host's gtag/js to the stand-in's server", async () => {
    let match: ((url: URL) => boolean) | undefined;
    let handle: ((route: unknown) => unknown) | undefined;
    await routeGtag(
      {
        route: async (m: typeof match, h: typeof handle) => {
          match = m;
          handle = h;
        },
      },
      { origin: "http://192.0.2.2:4000" },
    );
    expect(
      match?.(new URL(`https://${GTAG_HOST}/gtag/js?id=G-4KB2ZS573N`)),
    ).toBe(true);
    expect(match?.(new URL(`https://${GTAG_HOST}/gtm.js?id=GTM-X`))).toBe(
      false,
    );
    expect(
      match?.(new URL("https://www.google-analytics.com/g/collect?v=2")),
    ).toBe(false);
    expect(match?.(new URL("http://192.0.2.2:3151/gtag/js"))).toBe(false);
    let fulfilled: { status: number; headers: Record<string, string> } | null =
      null;
    handle?.({ fulfill: (r: typeof fulfilled) => (fulfilled = r) });
    expect(fulfilled).toMatchObject({
      status: 302,
      headers: { location: "http://192.0.2.2:4000/gtag/js" },
    });
  });
});

describe("serveGtag serves the stand-in over a real socket", () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.close();
  });

  it("gzips for a browser, answers 404 elsewhere, counts what it served", async () => {
    const served = await serveGtag({ host: "127.0.0.1" });
    open.push(served);
    expect(served.requests).toBe(0);

    const zipped = await fetch(`${served.origin}/gtag/js?id=G-X`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(zipped.status).toBe(200);
    expect(zipped.headers.get("content-type")).toContain("javascript");
    expect(zipped.headers.get("timing-allow-origin")).toBe("*");
    expect(zipped.headers.get("cache-control")).toBe("private, max-age=900");
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect((await zipped.text()).length).toBeGreaterThan(500_000);

    const other = await fetch(`${served.origin}/elsewhere`);
    expect(other.status).toBe(404);
    expect(served.requests).toBe(1);
    expect(served.decodedKB).toBeGreaterThan(500);
    expect(served.gzipKB).toBeLessThan(200);
  });

  it("serves a saved copy of the real tag when told to (GTAG_FILE)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtag-file-"));
    try {
      const file = join(dir, "gtag.js");
      writeFileSync(file, "/* a saved copy */");
      const served = await serveGtag({ host: "127.0.0.1", file });
      open.push(served);
      expect(served.fromFile).toBe(true);
      const bytes = await gtagBytes({ file });
      expect(bytes.body.toString()).toBe("/* a saved copy */");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
