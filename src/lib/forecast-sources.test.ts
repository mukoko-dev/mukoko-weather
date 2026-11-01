/**
 * forecast-sources: the one place the credit for an external forecast model
 * lives. Pins the wording against the Rust constants (the two sides serve and
 * display the same attribution), the modified-notice rule, and the gate that
 * keeps the model switched off until Apple's official mark is wired.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLAGS } from "./feature-flags";
import {
  APPLE_WEATHERKIT_MODEL,
  FORECAST_PROVIDERS,
  appleWeatherEnabled,
  creditFor,
  creditsFor,
  isExternalForecastModel,
  providerForModel,
  servedProviderFor,
} from "./forecast-sources";

const rust = readFileSync(
  join(process.cwd(), "workers/crates/weather-core/src/weatherkit/mod.rs"),
  "utf8",
);

/** The string value of `pub const NAME: &str = "...";` in the Rust module. */
function rustConst(name: string): string {
  const m = rust.match(new RegExp(`pub const ${name}: &str =\\s*"([^"]*)";`));
  expect(m, `${name} in weatherkit/mod.rs`).not.toBeNull();
  return m![1];
}

const apple = FORECAST_PROVIDERS["apple-weatherkit"];

describe("Apple Weather provider", () => {
  it("is the same model, name, provider and attribution the Rust side serves", () => {
    expect(apple.modelId).toBe(rustConst("MODEL_ID"));
    expect(APPLE_WEATHERKIT_MODEL).toBe(rustConst("MODEL_ID"));
    expect(apple.label).toBe(rustConst("LABEL"));
    expect(apple.servedProvider).toBe(rustConst("PROVIDER"));
    expect(apple.mark).toBe(rustConst("TRADEMARK"));
    expect(apple.href).toBe(rustConst("LEGAL_URL"));
    expect(apple.modifiedNotice).toBe(rustConst("MODIFIED_NOTICE"));
  });

  it("links Apple's legal page over https", () => {
    const url = new URL(apple.href);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("developer.apple.com");
    expect(url.pathname).toBe("/weatherkit/data-source-attribution/");
  });

  it("is served under its own provider name, never an open-meteo: variant", () => {
    expect(apple.servedProvider).not.toMatch(/^open-meteo/);
    expect(servedProviderFor(APPLE_WEATHERKIT_MODEL)).toBe("apple-weatherkit");
    expect(servedProviderFor("ecmwf_ifs")).toBe("open-meteo:ecmwf_ifs");
    expect(servedProviderFor("gfs_seamless")).toBe("open-meteo:gfs_seamless");
  });

  it("is external: it must never be sent to Open-Meteo", () => {
    expect(isExternalForecastModel(APPLE_WEATHERKIT_MODEL)).toBe(true);
    expect(providerForModel(APPLE_WEATHERKIT_MODEL)).toBe(apple);
    for (const m of ["best_match", "ecmwf_ifs", "gfs_seamless", "", null]) {
      expect(isExternalForecastModel(m), String(m)).toBe(false);
    }
    expect(providerForModel(undefined)).toBeUndefined();
  });
});

describe("the credit due", () => {
  it("is the trademark and the legal link for a plotted series, with no notice", () => {
    const c = creditFor(APPLE_WEATHERKIT_MODEL, "plotted");
    expect(c).toMatchObject({
      providerId: "apple-weatherkit",
      label: "Apple Weather",
      mark: "Weather",
      href: apple.href,
      notice: null,
    });
  });

  it("adds the modified notice for a baseline (value-added data)", () => {
    const c = creditFor(APPLE_WEATHERKIT_MODEL, "baseline");
    expect(c?.notice).toBe("Data provided by Apple has been modified.");
    expect(c?.href).toBe(apple.href);
  });

  it("is nothing for a model no credit is due for", () => {
    expect(creditFor("ecmwf_ifs", "baseline")).toBeNull();
    expect(creditFor("best_match", "plotted")).toBeNull();
    expect(creditFor(undefined, "plotted")).toBeNull();
  });

  it("is one credit per provider however many of its models are shown", () => {
    const list = creditsFor(
      [
        "ecmwf_ifs",
        APPLE_WEATHERKIT_MODEL,
        "gfs_seamless",
        APPLE_WEATHERKIT_MODEL,
      ],
      "plotted",
    );
    expect(list).toHaveLength(1);
    expect(list[0].providerId).toBe("apple-weatherkit");
    expect(creditsFor(["ecmwf_ifs", "icon_global"], "baseline")).toEqual([]);
    expect(creditsFor([], "baseline")).toEqual([]);
  });
});

describe("the switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off by default: a picker entry that does nothing would be a lie", () => {
    expect(FLAGS.apple_weatherkit).toBe(false);
    expect(appleWeatherEnabled()).toBe(false);
  });

  it("honours the local dev override", () => {
    const store: Record<string, string> = { "ff:apple_weatherkit": "true" };
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
    });
    expect(appleWeatherEnabled()).toBe(true);
    store["ff:apple_weatherkit"] = "false";
    expect(appleWeatherEnabled()).toBe(false);
  });

  it("cannot be turned on while Apple's official mark is not wired", () => {
    // Apple's terms ask for its Weather mark. Until the image is supplied the
    // credit is the trademark TEXT, which is a stand-in: the flag stays off.
    if (FLAGS.apple_weatherkit) {
      expect(apple.markAssetUrl).not.toBeNull();
    }
    // The wiring of the image (and the CSP img-src for Apple's host) is a
    // follow-up; the credit component renders text until then.
    expect(typeof FLAGS.apple_weatherkit).toBe("boolean");
  });
});
