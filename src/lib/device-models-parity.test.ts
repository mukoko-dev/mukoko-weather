/**
 * The device-profile endpoint lives in the Rust Worker
 * (`weather_core::community::FORECAST_MODELS`). A model the map can offer, or
 * that the My Weather radio group stores, that the Worker refuses would make
 * every preference sync for that device fail with a 400, so the two lists are
 * pinned here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAP_MODELS } from "./map-sources";
import { APPLE_WEATHERKIT_MODEL } from "./forecast-sources";
import { ForecastModel } from "./weather";

const rust = readFileSync(
  join(process.cwd(), "workers/crates/weather-core/src/community.rs"),
  "utf8",
);
const accepted = new Set(
  [
    ...rust
      .slice(rust.indexOf("pub const FORECAST_MODELS"))
      .split("];")[0]
      .matchAll(/"([a-z0-9_]+)"/g),
  ].map((m) => m[1]),
);

describe("device profile forecast models (Rust Worker allowlist)", () => {
  it("accepts every model the map can offer", () => {
    for (const m of MAP_MODELS) expect(accepted.has(m.id)).toBe(true);
  });

  it("accepts best_match and the legacy ids older devices carry", () => {
    for (const id of ["best_match", "ecmwf_ifs04", "icon_seamless"])
      expect(accepted.has(id)).toBe(true);
  });

  it("accepts Apple Weather before anything serves it", () => {
    // A device on a newer client may store it; refusing would fail every
    // preference sync for that device. Whether a person is OFFERED it is the
    // `apple_weatherkit` feature flag, not this list.
    expect(accepted.has(APPLE_WEATHERKIT_MODEL)).toBe(true);
  });

  it("is not an open list", () => {
    expect(accepted.has("gpt")).toBe(false);
    expect(accepted.size).toBe(12);
  });
});

describe("every model the My Weather picker can store is accepted", () => {
  it("accepts each ForecastModel value (a refusal would break device sync)", () => {
    for (const m of Object.values(ForecastModel)) {
      expect(accepted.has(m), m).toBe(true);
    }
  });
});

describe("device sync call sites", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("replication talks to the Worker, never /api/py/devices", () => {
    const src = read("src/lib/rxdb/replication.ts");
    expect(src).toContain('workerUrl(`devices/${deviceId}`, "")');
    expect(src).toContain('fetchWorker(`devices/${deviceId}`, "")');
    expect(src).not.toContain("/api/py/devices");
    expect(src).not.toMatch(/\$\{API_BASE\}\/devices/);
  });

  it("the service worker never caches device sync", () => {
    expect(read("src/app/sw.ts")).toContain(
      'url.pathname.startsWith("/v1/devices")',
    );
  });
});
