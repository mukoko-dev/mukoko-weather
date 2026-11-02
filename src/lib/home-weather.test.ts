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
});

describe("fetchHomeWeather abandons a request the visitor left (issue #414)", () => {
  it("rejects on abort instead of falling through to Open-Meteo from the phone", async () => {
    const { fetchHomeWeather } = await import("./home-weather");
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchHomeWeather(-17.83, 31.05, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    // One request to the Worker; no direct provider call after the abort.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /open-meteo\.com/.test(u))).toBe(false);
  });

  it("does not start at all when already abandoned", async () => {
    const { fetchHomeWeather } = await import("./home-weather");
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchHomeWeather(-17.83, 31.05, controller.signal),
    ).rejects.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
