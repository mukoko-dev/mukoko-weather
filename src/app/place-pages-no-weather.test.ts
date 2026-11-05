/**
 * Issue #414: the pages for a place (`/` and `/[location]`) make NO weather
 * call on the server.
 *
 * The server render used to await `getWeatherForLocation` (the Worker with a
 * 2.5 s timeout, a hedge to a direct Open-Meteo read after 1.5 s, then the
 * seasonal estimate). Those calls left from Vercel's few shared egress
 * addresses, so under load the Worker's per-IP limiter answered 429, the
 * hedged read was limited too, and the page rendered the seasonal estimate
 * as if it were data (the stuck "Live weather data temporarily unavailable"
 * banner). The visitor's own browser fetches the forecast now, with its own
 * address and its own budget.
 *
 * Two guards, so neither a refactor nor a new import can bring it back:
 *   1. behaviour: render both pages with fetch and the weather loaders
 *      spied on; nothing weather-shaped may be called or awaited;
 *   2. structure: no server module reachable from the pages imports a
 *      weather loader (client modules are skipped: their code runs in the
 *      browser, in effects).
 */
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSlug } from "@/lib/slug-migration";

const SRC = resolve(__dirname, "..");

// ── 1. behaviour ────────────────────────────────────────────────────────────

const getWeatherForLocation = vi.fn();
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getWeatherForLocation: (...args: unknown[]) =>
      getWeatherForLocation(...args),
  };
});
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => null }));
// The place stage reads the signed-in person from AuthKit's provider in the
// browser (useAiUser); the provider's module cannot be loaded outside Next.
vi.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, prefetch: () => {} }),
}));
// What the request carries, set per test: the cookie and the edge's IP-geo headers.
let requestCookie: string | undefined = "harare";
let requestHeaders: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "lastLocation" && requestCookie
        ? { value: requestCookie }
        : undefined,
  }),
  headers: async () => new Headers(requestHeaders),
}));

const WEATHER_URL = /\/v1\/weather|open-meteo\.com|api\.tomorrow\.io/i;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  requestCookie = "harare";
  requestHeaders = {};
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

describe("/[location] server render", () => {
  it("renders the place and calls no weather loader and no weather URL", async () => {
    const { default: LocationPage } = await import("./[location]/page");
    const tree = await LocationPage({
      params: Promise.resolve({ location: "harare" }),
    });
    expect(tree).toBeTruthy();
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });

  it("hands the client a place with no weather in its props", async () => {
    const { default: LocationPage } = await import("./[location]/page");
    const tree = (await LocationPage({
      params: Promise.resolve({ location: "harare" }),
    })) as { props: { children: Array<{ props: Record<string, unknown> }> } };
    const stage = tree.props.children.find((c) => c?.props?.seed);
    expect(stage).toBeTruthy();
    const seed = stage!.props.seed as Record<string, unknown>;
    expect(Object.keys(seed).sort()).toEqual([
      "countryName",
      "location",
      "season",
    ]);
    expect(JSON.stringify(stage!.props)).not.toMatch(
      /temperature_2m|hourly|usingFallback/,
    );
  });

  it("generateMetadata calls no weather loader either", async () => {
    const { generateMetadata } = await import("./[location]/page");
    await generateMetadata({ params: Promise.resolve({ location: "harare" }) });
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });
});

describe("/ server render", () => {
  it("renders the cookie's place and calls no weather loader and no weather URL", async () => {
    const { default: Home } = await import("./page");
    // Home is a Suspense around HomeContent; run the content to completion.
    const suspense = Home() as unknown as {
      props: { children: { type: (p: object) => Promise<unknown> } };
    };
    const content = (await suspense.props.children.type({})) as {
      props: { initial: Record<string, unknown> | null };
    };
    expect(content.props.initial).not.toBeNull();
    expect(Object.keys(content.props.initial!).sort()).toEqual([
      "countryName",
      "location",
      "season",
    ]);
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });

  /** Run `/` to completion and return what it hands the client home. */
  async function renderHome(): Promise<Record<string, unknown> | null> {
    const { default: Home } = await import("./page");
    const suspense = Home() as unknown as {
      props: { children: { type: (p: object) => Promise<unknown> } };
    };
    const content = (await suspense.props.children.type({})) as {
      props: { initial: Record<string, unknown> | null };
    };
    return content.props.initial;
  }

  it("with no cookie and no IP position seeds Harare, not a chooser, and calls no weather", async () => {
    requestCookie = undefined;
    requestHeaders = {};
    const initial = await renderHome();
    // `initial: null` is what renders the client's city chooser; it must not.
    expect(initial).not.toBeNull();
    expect((initial!.location as { slug: string }).slug).toBe(
      canonicalSlug("harare"),
    );
    expect(initial!.countryName).toBe("Zimbabwe");
    expect(Object.keys(initial!).sort()).toEqual([
      "countryName",
      "location",
      "season",
    ]);
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });

  it("seeds the nearest shipped city for a Nairobi or Lagos IP position, with no lookup and no weather", async () => {
    for (const [lat, lon, country, city, slug] of [
      ["-1.2921", "36.8219", "KE", "Nairobi", "nairobi-ke"],
      ["6.5244", "3.3792", "NG", "Lagos", "lagos-ng"],
    ]) {
      requestCookie = undefined;
      requestHeaders = {
        "x-vercel-ip-latitude": lat,
        "x-vercel-ip-longitude": lon,
        "x-vercel-ip-country": country,
        "x-vercel-ip-city": city,
      };
      const initial = await renderHome();
      expect(initial, city).not.toBeNull();
      // Pages carry the canonical slug of a shipped place (#317).
      expect((initial!.location as { slug: string }).slug, city).toBe(
        canonicalSlug(slug),
      );
    }
    expect(getWeatherForLocation).not.toHaveBeenCalled();
    expect(weatherFetches()).toEqual([]);
  });
});

// ── 2. structure ────────────────────────────────────────────────────────────

/** Symbols that fetch a forecast. None may be imported by the place pages. */
const WEATHER_LOADERS = [
  "getWeatherForLocation",
  "loadLocationWeather",
  "loadLocationPayload",
  "createFallbackWeather",
  "fetchWeather",
  "fetchHomeWeather",
  "fetchModelWeather",
];

const ENTRIES = [
  "app/page.tsx",
  "app/[location]/page.tsx",
  "app/[location]/load-location.ts",
  "lib/load-location.ts",
  "lib/place-seed-server.ts",
  "lib/local-place.ts",
  "lib/season-local.ts",
];

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
]);

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? resolve(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const file = base + ext;
    if (existsSync(file) && /\.(ts|tsx)$/.test(file)) return file;
  }
  return null;
}

function importsOf(file: string): { names: string[]; spec: string }[] {
  const text = readFileSync(file, "utf-8");
  const out: { names: string[]; spec: string }[] = [];
  const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) continue; // type-only imports are erased
    const clause = m[2];
    const names = [...clause.matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+[\w$]+)?/g)]
      .map((n) => n[1])
      .filter((n) => n !== "type" && n !== "as");
    out.push({ names, spec: m[3] });
  }
  return out;
}

function isClientModule(file: string): boolean {
  return /^\s*["']use client["']/.test(readFileSync(file, "utf-8"));
}

/** Server modules reachable from the entries (client modules are skipped). */
function serverGraph(): string[] {
  const seen = new Set<string>();
  const queue = ENTRIES.map((e) => resolve(SRC, e));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    if (isClientModule(file)) continue;
    seen.add(file);
    for (const { spec } of importsOf(file)) {
      const target = resolveImport(file, spec);
      if (target) queue.push(target);
    }
  }
  return [...seen];
}

describe("the place pages' server graph", () => {
  const graph = serverGraph();

  it("reaches the modules the pages really use (the guard is not vacuous)", () => {
    const names = graph.map((f) => f.slice(SRC.length + 1));
    expect(names).toContain("app/page.tsx");
    expect(names).toContain("app/[location]/page.tsx");
    expect(names).toContain("lib/place-seed-server.ts");
    expect(names).toContain("lib/db.ts");
  });

  it("imports no weather loader into any server module on the path", () => {
    const offenders: string[] = [];
    for (const file of graph) {
      const rel = file.slice(SRC.length + 1);
      if (LIBRARIES.has(rel)) continue;
      for (const { names, spec } of importsOf(file)) {
        for (const name of names) {
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
      const rel = file.slice(SRC.length + 1);
      if (FORECAST_LIBRARIES.has(rel)) continue;
      const text = readFileSync(file, "utf-8");
      if (
        /workerUrl\(\s*["']weather["']|\/v1\/weather|open-meteo\.com/.test(text)
      )
        offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
