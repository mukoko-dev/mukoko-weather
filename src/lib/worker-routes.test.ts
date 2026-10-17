import { describe, expect, it } from "vitest";
import {
  WORKER_ROUTES,
  parseWorkerBase,
  parseWorkerRoutes,
  weatherApiUrl,
} from "./worker-routes";
import { readFileSync } from "node:fs";

const BASE = "https://weather-api.mukoko.com";

describe("worker route cutover", () => {
  it("is dormant by default", () => {
    expect(weatherApiUrl("/api/py/search?q=harare")).toBe("/api/py/search?q=harare");
    expect(weatherApiUrl("/api/py/geo?lat=1&lon=2", {})).toBe("/api/py/geo?lat=1&lon=2");
    // A base alone, or a route list alone, switches nothing.
    expect(weatherApiUrl("/api/py/search?q=a", { base: BASE })).toBe("/api/py/search?q=a");
    expect(weatherApiUrl("/api/py/search?q=a", { routes: "search" })).toBe("/api/py/search?q=a");
  });

  it("switches only the listed routes, each on its own", () => {
    const env = { base: BASE, routes: "search" };
    expect(weatherApiUrl("/api/py/search?q=harare&limit=8", env)).toBe(
      `${BASE}/v1/search?q=harare&limit=8`,
    );
    expect(weatherApiUrl("/api/py/geo?lat=1&lon=2", env)).toBe("/api/py/geo?lat=1&lon=2");
    const both = { base: `${BASE}/`, routes: " Search , geo " };
    expect(weatherApiUrl("/api/py/geo?lat=1&lon=2&autoCreate=true", both)).toBe(
      `${BASE}/v1/geo?lat=1&lon=2&autoCreate=true`,
    );
  });

  it("rolls back by unsetting the list", () => {
    expect(weatherApiUrl("/api/py/search?q=a", { base: BASE, routes: "" })).toBe(
      "/api/py/search?q=a",
    );
  });

  it("never switches a route the Worker does not serve", () => {
    const env = { base: BASE, routes: "locations,search,geo,locations/add,weather" };
    expect(weatherApiUrl("/api/py/locations/add", env)).toBe("/api/py/locations/add");
    expect(weatherApiUrl("/api/py/locations/profile?slug=x", env)).toBe(
      "/api/py/locations/profile?slug=x",
    );
    expect(weatherApiUrl("/api/py/weather?lat=1&lon=2", env)).toBe("/api/py/weather?lat=1&lon=2");
    expect(weatherApiUrl("/api/py/locations?slug=harare", env)).toBe(
      `${BASE}/v1/locations?slug=harare`,
    );
    expect(parseWorkerRoutes("locations/add, weather,,SEARCH")).toEqual(new Set(["search"]));
  });

  it("accepts only a bare https origin (or localhost) as the base", () => {
    expect(parseWorkerBase(BASE)).toBe(BASE);
    expect(parseWorkerBase("http://localhost:8787")).toBe("http://localhost:8787");
    for (const bad of [
      "",
      "http://weather-api.mukoko.com",
      "https://user:pw@weather-api.mukoko.com",
      "https://weather-api.mukoko.com/v1",
      "https://weather-api.mukoko.com?x=1",
      "not a url",
      undefined,
    ]) {
      expect(parseWorkerBase(bad)).toBeNull();
    }
    expect(weatherApiUrl("/api/py/search?q=a", { base: "http://evil.example", routes: "search" })).toBe(
      "/api/py/search?q=a",
    );
  });

  it("maps every switchable route to the public API's /v1 path", () => {
    expect(WORKER_ROUTES).toEqual({
      search: "/v1/search",
      geo: "/v1/geo",
      locations: "/v1/locations",
    });
  });

  it("is used by the browser search and geolocation calls", () => {
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
    expect(read("./use-location-quick-search.ts")).toContain("weatherApiUrl(");
    expect(read("./geolocation.ts")).toContain("weatherApiUrl(");
  });
});
