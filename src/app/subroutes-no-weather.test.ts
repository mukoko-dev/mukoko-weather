/**
 * Issue #452: the sub-routes of a place (`/[location]/forecast`,
 * `/[location]/atmosphere`) and the wall display (`/display`) make NO weather
 * call on the server, the rule `/` and `/[location]` already follow (#414).
 *
 * Their server render used to await `loadLocationPayload` /
 * `getWeatherForLocation` (the Worker with a 2.5 s timeout, hedged to a direct
 * Open-Meteo read, then the seasonal estimate) before sending a single byte.
 * The visitor's own browser fetches the forecast now, painted over the copy
 * stored on the device (`usePageWeather`).
 *
 * Three guards per route, so neither a refactor nor a new import can bring it
 * back:
 *   1. behaviour: run each page with fetch and the weather loaders spied on;
 *      nothing weather-shaped may be called, and the props handed to the
 *      client carry no weather;
 *   2. structure: no server module reachable from the page imports a weather
 *      loader or names a weather URL (client modules are skipped: their code
 *      runs in the browser);
 *   3. the client side: the dashboards get their weather only from
 *      `usePageWeather` (the place stage's state machine through the shared
 *      Worker read), never from a raw fetch of their own.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  importsOf,
  relativeToSrc,
  serverGraph,
} from "@/lib/test-support/server-graph";

// ── 1. behaviour ────────────────────────────────────────────────────────────

const getWeatherForLocation = vi.fn();
/** What the place store answers; null leaves the real lookup in place. */
let storeLookup: ((slug: string) => Promise<unknown>) | null = null;
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getWeatherForLocation: (...args: unknown[]) =>
      getWeatherForLocation(...args),
    getLocationFromDb: (slug: string) =>
      storeLookup ? storeLookup(slug) : actual.getLocationFromDb(slug),
  };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, prefetch: () => {} }),
}));
// The page chrome is a different layer; the first-HTML tests below look at the
// dashboards' own output, so PageShell is a passthrough that keeps the trail
// visible.
vi.mock("@/components/layout/PageShell", () => ({
  PageShell: ({
    children,
    breadcrumb,
  }: {
    children: ReactNode;
    breadcrumb?: { label: string }[];
  }) =>
    createElement(
      "main",
      { "data-trail": (breadcrumb ?? []).map((b) => b.label).join(" > ") },
      children,
    ),
}));
let requestCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "lastLocation" && requestCookie
        ? { value: requestCookie }
        : undefined,
  }),
  headers: async () => new Headers(),
}));

const WEATHER_URL = /\/v1\/weather|open-meteo\.com|api\.tomorrow\.io/i;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  requestCookie = undefined;
  storeLookup = null;
  getWeatherForLocation.mockReset();
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("no network in this test"));
});
afterEach(() => fetchSpy.mockRestore());

function weatherFetches(): string[] {
  return fetchSpy.mock.calls
    .map(([input]: [RequestInfo | URL]) => String(input))
    .filter((url: string) => WEATHER_URL.test(url));
}

type Element = { props: Record<string, unknown> };

/** The element of a returned fragment whose props include `prop`. */
function childWith(tree: unknown, prop: string): Element | undefined {
  const children = (tree as { props: { children: Element[] } }).props.children;
  return children.find((c) => c?.props && prop in c.props);
}

type RoutePage = {
  default: (p: { params: Promise<{ location: string }> }) => Promise<unknown>;
  generateMetadata: (p: {
    params: Promise<{ location: string }>;
  }) => Promise<unknown>;
};
const PAGES: Array<[string, () => Promise<RoutePage>]> = [
  [
    "forecast",
    () => import("./[location]/forecast/page") as Promise<RoutePage>,
  ],
  [
    "atmosphere",
    () => import("./[location]/atmosphere/page") as Promise<RoutePage>,
  ],
];

describe.each(PAGES)("/[location]/%s server render", (_route, load) => {
  const params = Promise.resolve({ location: "harare" });

  it("renders the place and calls no weather loader and no weather URL", async () => {
    const { default: Page } = await load();
    const tree = await Page({ params });
    expect(tree).toBeTruthy();
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });

  it("hands the client a place and a season, and no weather", async () => {
    const { default: Page } = await load();
    const tree = await Page({ params });
    const dashboard = childWith(tree, "season");
    expect(dashboard).toBeTruthy();
    expect(Object.keys(dashboard!.props).sort()).toEqual([
      "location",
      "season",
    ]);
    expect((dashboard!.props.location as { slug: string }).slug).toBe("harare");
    expect(JSON.stringify(dashboard!.props)).not.toMatch(
      /temperature_2m|hourly|usingFallback|frostAlert/,
    );
  });

  it("strips the store's _id before the place crosses to the client", async () => {
    storeLookup = async () => ({
      _id: { toJSON: () => "objectid" },
      slug: "harare",
      name: "Harare",
      province: "Harare",
      lat: -17.83,
      lon: 31.05,
      elevation: 1490,
      tags: ["city"],
      country: "ZW",
      updatedAt: new Date(),
    });
    const { default: Page } = await load();
    const tree = await Page({ params });
    const dashboard = childWith(tree, "season")!;
    expect(dashboard.props.location).not.toHaveProperty("_id");
  });

  it("remounts the dashboard for another place (one controller per place)", async () => {
    const { default: Page } = await load();
    const tree = (await Page({ params })) as {
      props: { children: Array<{ key: string | null; props: object }> };
    };
    const dashboard = tree.props.children.find(
      (c) => c?.props && "season" in c.props,
    );
    expect(dashboard?.key).toBe("harare");
  });

  it("generateMetadata calls no weather loader either", async () => {
    const { generateMetadata } = await load();
    await generateMetadata({ params });
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });
});

describe("/display server render", () => {
  async function renderDisplay(
    search: Record<string, string | string[] | undefined>,
  ) {
    const { default: DisplayPage } = await import("./display/page");
    return (await DisplayPage({
      searchParams: Promise.resolve(search),
    })) as Element;
  }

  it("renders a shipped place and calls no weather loader and no weather URL", async () => {
    const tree = await renderDisplay({ location: "harare" });
    expect((tree.props.location as { slug: string }).slug).toBe("harare");
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });

  it("hands the screen a place and settings, and no weather", async () => {
    const tree = await renderDisplay({ location: "harare" });
    expect(Object.keys(tree.props).sort()).toEqual([
      "layer",
      "location",
      "theme",
    ]);
    expect(tree.props).not.toHaveProperty("initialWeather");
  });

  it("does the same for a free coordinate and for the cookie's place", async () => {
    await renderDisplay({ lat: "1.35", lon: "103.82" });
    requestCookie = "bulawayo";
    const tree = await renderDisplay({});
    expect((tree.props.location as { slug: string }).slug).toBe("bulawayo");
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });

  it("does not wait for the place store when the app ships the place", async () => {
    // A hung database must not hold a wall display's first byte.
    storeLookup = () => new Promise(() => {});
    const tree = await renderDisplay({ location: "bulawayo" });
    expect((tree.props.location as { slug: string }).slug).toBe("bulawayo");
    requestCookie = "harare";
    const fromCookie = await renderDisplay({});
    expect((fromCookie.props.location as { slug: string }).slug).toBe("harare");
  });
});

// ── 2. structure ────────────────────────────────────────────────────────────

/** Symbols that fetch a forecast. None may be imported by these pages. */
const WEATHER_LOADERS = [
  "getWeatherForLocation",
  "loadLocationWeather",
  "loadLocationPayload",
  "createFallbackWeather",
  "fetchWeather",
  "fetchHomeWeather",
  "fetchModelWeather",
];

const ROUTES = {
  forecast: [
    "app/[location]/forecast/page.tsx",
    "app/[location]/layout.tsx",
    "lib/load-location.ts",
    "lib/place-seed-server.ts",
  ],
  atmosphere: [
    "app/[location]/atmosphere/page.tsx",
    "app/[location]/layout.tsx",
    "lib/load-location.ts",
    "lib/place-seed-server.ts",
  ],
  display: ["app/display/page.tsx"],
} as const;

/** `src/lib/db.ts` is a library of many things; importers are checked by name. */
const LIBRARIES = new Set(["lib/db.ts"]);
/**
 * Pure forecast helpers (`getDefaultSeason`, types) live in modules that also
 * hold the browser's Open-Meteo client. Reaching them is fine; calling a
 * loader is not, and that is what the import check and the behaviour tests
 * above pin.
 */
const FORECAST_LIBRARIES = new Set([
  ...LIBRARIES,
  "lib/weather.ts",
  "lib/open-meteo-endpoint.ts",
  "lib/derived-insights.ts",
  // The map credits' link to Open-Meteo's home page (shown to people, never
  // fetched); the display page reaches it through the map layer list.
  "lib/map-sources.ts",
]);

/** Code only: a comment that names a route is not a call to it. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe.each(Object.entries(ROUTES))(
  "the %s server graph",
  (_name, entries) => {
    const graph = serverGraph(entries);
    const names = graph.map(relativeToSrc);

    it("reaches the modules the page really uses (the guard is not vacuous)", () => {
      expect(names).toContain(entries[0]);
      expect(names).toContain("lib/db.ts");
    });

    it("imports no weather loader into any server module on the path", () => {
      const offenders: string[] = [];
      for (const file of graph) {
        const rel = relativeToSrc(file);
        if (LIBRARIES.has(rel)) continue;
        for (const { names: imported, spec } of importsOf(file)) {
          for (const name of imported) {
            if (WEATHER_LOADERS.includes(name)) {
              offenders.push(`${rel} imports ${name} from ${spec}`);
            }
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it("names no weather URL in any other server module on the path", () => {
      const offenders: string[] = [];
      for (const file of graph) {
        const rel = relativeToSrc(file);
        if (FORECAST_LIBRARIES.has(rel)) continue;
        const text = withoutComments(readFileSync(file, "utf-8"));
        if (
          /workerUrl\(\s*["']weather["']|\/v1\/weather|open-meteo\.com/.test(
            text,
          )
        )
          offenders.push(rel);
      }
      expect(offenders).toEqual([]);
    });
  },
);

// ── 3. the client side ──────────────────────────────────────────────────────

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "..", rel), "utf-8");

describe("the dashboards fetch their weather only through usePageWeather", () => {
  const dashboards = [
    "app/[location]/forecast/ForecastDashboard.tsx",
    "app/[location]/atmosphere/AtmosphereDashboard.tsx",
  ];

  it.each(dashboards)(
    "%s takes no weather props and makes no call of its own",
    (file) => {
      const source = read(file);
      expect(source).toContain("usePageWeather(");
      expect(source).not.toContain("weather: WeatherData");
      expect(source).not.toMatch(/\bfetchWorker\b|\bfetch\(/);
      expect(source).not.toContain("getWeatherForLocation");
      expect(source).not.toContain("createFallbackWeather");
    },
  );

  it.each(dashboards)(
    "%s paints a skeleton, and the notice, until a view exists",
    (file) => {
      const source = read(file);
      expect(source).toMatch(/BodySkeleton \/>/);
      expect(source).toContain(
        "<PageWeatherNotice state={state} retry={retry} />",
      );
      expect(source).toContain("state.device");
    },
  );

  it("usePageWeather is the place stage's controller over the shared Worker read", () => {
    const hook = read("lib/use-page-weather.ts");
    expect(hook).toContain("createPlaceController(");
    expect(hook).toContain("fetchHomeWeather(lat, lon)");
    expect(hook).toContain("recallPlace(slug)");
    expect(hook).toContain('workerData.invalidate("weather", { lat, lon })');
    expect(hook).not.toMatch(/\bfetchWorker\b|\bfetch\(/);
    // A page that is not the stage never switches place: no bus, no URL push.
    expect(hook).not.toContain("registerPlaceStage");
    expect(hook).not.toContain("pushState");
    expect(hook).not.toContain("location.reload");
  });

  it("the display screen has no server-seeded forecast", () => {
    const dash = read("app/display/DisplayDashboard.tsx");
    expect(dash).not.toContain("initialWeather");
    expect(dash).not.toContain("WeatherData");
    expect(read("app/display/page.tsx")).not.toContain("initialWeather");
  });
});

describe("the first HTML of a sub-route (what the server sends)", () => {
  const location = {
    slug: "harare",
    name: "Harare",
    province: "Harare",
    lat: -17.83,
    lon: 31.05,
    elevation: 1490,
    tags: ["city"],
    country: "ZW",
  };
  const season = {
    name: "Dry season",
    localName: "Chirimo",
    description: "Warm and dry",
  };

  it("has the heading, the place line and a skeleton, and no forecast", async () => {
    const { ForecastDashboard } =
      await import("./[location]/forecast/ForecastDashboard");
    const html = renderToString(
      createElement(ForecastDashboard, { location, season }),
    );
    expect(html).toContain("Harare Forecast");
    expect(html).toContain("1490m");
    expect(html).toContain("Home &gt; Harare &gt; Forecast");
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/°|Live weather data temporarily unavailable/);
    // No stored copy exists on the server, so no "Updated N min ago" either.
    expect(html).not.toContain("Updated");
  });

  it("does the same for the atmosphere page, and keeps air quality independent of the forecast", async () => {
    const { AtmosphereDashboard } =
      await import("./[location]/atmosphere/AtmosphereDashboard");
    const html = renderToString(
      createElement(AtmosphereDashboard, { location, season }),
    );
    expect(html).toContain("Harare Atmosphere");
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/°/);
    const source = read("app/[location]/atmosphere/AtmosphereDashboard.tsx");
    // Air quality sits outside the weather-dependent branch.
    const afterBranch = source.slice(source.indexOf("<AtmosphereBodySkeleton"));
    expect(afterBranch).toContain("<AirQualityDetails");
  });
});
