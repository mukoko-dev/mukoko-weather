import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelWeather } from "./home-weather";
import { createFallbackWeather } from "./weather";

function respond(provider: string) {
  const body = createFallbackWeather(-17.83, 31.05, 1483);
  return {
    ok: true,
    headers: new Headers({ "X-Weather-Provider": provider }),
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchModelWeather (issue #246)", () => {
  it("asks our API for the selected model + comparison set", async () => {
    const fetchMock = vi.fn(async () => respond("open-meteo:gfs_seamless"));
    vi.stubGlobal("fetch", fetchMock);
    const { baseline } = await fetchModelWeather(
      -17.83,
      31.05,
      "gfs_seamless",
      ["gfs_seamless", "ecmwf_ifs"],
    );
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("weather-api.mukoko.com/v1/weather?");
    expect(url).toContain("model=gfs_seamless");
    expect(url).toContain("models=gfs_seamless%2Cecmwf_ifs");
    expect(baseline).not.toBeNull();
  });

  it("the blend default never swaps the seeded baseline", async () => {
    const fetchMock = vi.fn(async () => respond("open-meteo:blend"));
    vi.stubGlobal("fetch", fetchMock);
    const { data, baseline } = await fetchModelWeather(
      -17.83,
      31.05,
      "best_match",
      ["best_match", "ecmwf_ifs"],
    );
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).not.toContain("model=");
    expect(url).toContain("models=ecmwf_ifs");
    expect(baseline).toBeNull();
    expect(data.current).toBeDefined();
  });

  it("does not treat a fallen-back provider as the chosen model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond("open-meteo:best_match")),
    );
    const { baseline } = await fetchModelWeather(-17.83, 31.05, "ecmwf_ifs", [
      "ecmwf_ifs",
    ]);
    expect(baseline).toBeNull();
  });

  it("takes Apple Weather's own provider name as the chosen model (not open-meteo:)", async () => {
    const fetchMock = vi.fn(async () => respond("apple-weatherkit"));
    vi.stubGlobal("fetch", fetchMock);
    const { baseline } = await fetchModelWeather(
      -17.83,
      31.05,
      "apple_weatherkit",
      ["apple_weatherkit", "ecmwf_ifs"],
    );
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("model=apple_weatherkit");
    expect(baseline).not.toBeNull();
  });

  it("an Apple pick answered with the blend is not swapped onto Apple", async () => {
    // Not configured, over budget, circuit open: the Worker serves the blend
    // and says so; the page must not label it Apple's forecast.
    for (const provider of ["open-meteo:blend", "open-meteo:best_match"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond(provider)),
      );
      const { baseline } = await fetchModelWeather(
        -17.83,
        31.05,
        "apple_weatherkit",
        ["apple_weatherkit"],
      );
      expect(baseline, provider).toBeNull();
    }
    // And an Open-Meteo-looking header is never read as Apple.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond("open-meteo:apple_weatherkit")),
    );
    const { baseline } = await fetchModelWeather(
      -17.83,
      31.05,
      "apple_weatherkit",
      ["apple_weatherkit"],
    );
    expect(baseline).toBeNull();
  });
});
