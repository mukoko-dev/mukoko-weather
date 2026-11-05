/**
 * Issue #452: the shell never waits on data.
 *
 * Owner rule (2026-11-03): "An app, a page, a layout, a container has never
 * depended on data. It should load and then the data loads after it as and
 * when it's needed."
 *
 * `/[location]` and `/` used to await, in front of what they send: a place
 * lookup (the database, a Mongo round trip even for a shipped place, in a
 * layout ABOVE `loading.tsx`, so it held the first byte of every place page),
 * the season (database, 800 ms budget), the country (a function that reads a
 * static list but is async), and the signed-in user. Now a shipped place and
 * a spot are named from the seed and the slug, the season comes from the
 * prebuilt table, and the signed-in person is read by the browser from
 * AuthKit's provider.
 *
 * Two kinds of guard, so neither a refactor nor a new import can bring a wait
 * back:
 *   1. behaviour: every data source the pages could wait for hangs forever
 *      (a hung database, a hung session, a hung Worker) and under fake timers
 *      the pages still finish: any awaited timeout would never fire and the
 *      test would hang;
 *   2. structure: the pages' server modules do not import the modules that
 *      wait (the session, the stored geography for a place the slug names,
 *      the database season).
 */
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSmartSlug } from "@/lib/smart-slug";
import { canonicalSlug } from "@/lib/slug-migration";
import {
  importsOf,
  relativeToSrc,
  serverGraph,
} from "@/lib/test-support/server-graph";

const HANG = () => new Promise<never>(() => undefined);
/** A spot about 10 km from Harare: its own slug names it. */
const SPOT = buildSmartSlug("My Farm", -17.9, 31.1)!;

const getLocationFromDb = vi.fn();
const getCurrentUser = vi.fn();
const getSeasonForDate = vi.fn();
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getLocationFromDb: (...a: unknown[]) => getLocationFromDb(...a),
    getSeasonForDate: (...a: unknown[]) => getSeasonForDate(...a),
  };
});
vi.mock("@/lib/auth", () => ({
  getCurrentUser: (...a: unknown[]) => getCurrentUser(...a),
}));
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

type Element = { props: Record<string, unknown>; type?: unknown };
const stageOf = (tree: unknown): Element | undefined =>
  (tree as { props: { children: Element[] } }).props.children.find(
    (c) => c?.props && "seed" in c.props,
  );

beforeEach(() => {
  vi.useFakeTimers();
  requestCookie = undefined;
  // Every source of data hangs: a page that awaits any of them never finishes.
  getLocationFromDb.mockReset().mockImplementation(HANG);
  getCurrentUser.mockReset().mockImplementation(HANG);
  getSeasonForDate.mockReset().mockImplementation(HANG);
  vi.spyOn(globalThis, "fetch").mockImplementation(HANG);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("/[location]: the render waits for nothing", () => {
  const render = async (slug: string) => {
    const { default: Page } = await import("./[location]/page");
    return Page({ params: Promise.resolve({ location: slug }) });
  };

  it.each(["harare", "nairobi-ke", "singapore-sg", "lagos-ng"])(
    "a shipped place (%s) renders with every data source hung",
    async (slug) => {
      const stage = stageOf(await render(slug));
      expect(stage).toBeTruthy();
      expect(
        (stage!.props.seed as { location: { slug: string } }).location.slug,
      ).toBe(canonicalSlug(slug));
      expect(getLocationFromDb).not.toHaveBeenCalled();
      expect(getCurrentUser).not.toHaveBeenCalled();
      expect(getSeasonForDate).not.toHaveBeenCalled();
    },
  );

  it("a spot renders from its own slug, with the region the nearest shipped place lends", async () => {
    // Close to Harare: the country, province and height come from the seed,
    // marked approximate so the forecast's time zone can correct them.
    const stage = stageOf(await render(SPOT));
    const seed = stage!.props.seed as {
      location: {
        slug: string;
        country?: string;
        regionApproximate?: boolean;
        elevationApproximate?: boolean;
      };
      countryName: string;
    };
    expect(seed.location.slug).toBe(SPOT);
    expect(seed.location.regionApproximate).toBe(true);
    expect(seed.location.elevationApproximate).toBe(true);
    expect(getLocationFromDb).not.toHaveBeenCalled();
  });

  it("the season is the prebuilt table's (local names), never a database read", async () => {
    const stage = stageOf(await render("harare"));
    const season = (stage!.props.seed as { season: { name: string } }).season;
    expect(typeof season.name).toBe("string");
    expect(season.name.length).toBeGreaterThan(0);
    expect(getSeasonForDate).not.toHaveBeenCalled();
  });

  it("a slug only a lookup can name sends the shell and a resolver, and asks nothing on the server", async () => {
    const tree = (await render("sembawang-sg")) as Element;
    const { PlaceResolver } =
      await import("@/components/weather/PlaceResolver");
    expect(tree.type).toBe(PlaceResolver);
    expect(tree.props).toEqual({ slug: "sembawang-sg" });
    expect(getLocationFromDb).not.toHaveBeenCalled();
  });

  it("never throws not-found for a slug nobody ships: the browser answers that", async () => {
    await expect(render("pricing")).resolves.toBeTruthy();
    await expect(render("zzzz-not-a-place")).resolves.toBeTruthy();
  });

  it("generateMetadata asks nothing for a shipped place or a spot either", async () => {
    const { generateMetadata } = await import("./[location]/page");
    for (const slug of ["harare", SPOT]) {
      const meta = (await generateMetadata({
        params: Promise.resolve({ location: slug }),
      })) as { title?: string };
      expect(String(meta.title)).toContain("Weather");
    }
    expect(getLocationFromDb).not.toHaveBeenCalled();
    expect(getSeasonForDate).not.toHaveBeenCalled();
  });
});

describe("/: the render waits for nothing it can name itself", () => {
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

  it("a returning visitor's shipped place, with every data source hung", async () => {
    requestCookie = "bulawayo";
    const initial = await renderHome();
    expect(initial).not.toBeNull();
    expect((initial!.location as { slug: string }).slug).toBe(
      canonicalSlug("bulawayo"),
    );
    expect(Object.keys(initial!).sort()).toEqual([
      "countryName",
      "location",
      "season",
    ]);
    expect(getLocationFromDb).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getSeasonForDate).not.toHaveBeenCalled();
  });

  it("a returning visitor's spot, with every data source hung", async () => {
    requestCookie = SPOT;
    const initial = await renderHome();
    expect((initial!.location as { slug: string }).slug).toBe(SPOT);
    expect(getLocationFromDb).not.toHaveBeenCalled();
  });

  it("a first visit seeds Harare with no lookup at all", async () => {
    const initial = await renderHome();
    expect((initial!.location as { slug: string }).slug).toBe(
      canonicalSlug("harare"),
    );
    expect(getLocationFromDb).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("hands the client a place, never the signed-in person", async () => {
    requestCookie = "harare";
    const { default: Home } = await import("./page");
    const suspense = Home() as unknown as {
      props: { children: { type: (p: object) => Promise<unknown> } };
    };
    const content = (await suspense.props.children.type({})) as {
      props: Record<string, unknown>;
    };
    expect(Object.keys(content.props)).toEqual(["initial"]);
  });
});

describe("the signed-in person is read in the browser", () => {
  it("useAiUser reads AuthKit's provider, which the root layout hydrates", () => {
    const hook = readFileSync(
      resolve(__dirname, "../lib/use-ai-user.ts"),
      "utf-8",
    );
    expect(hook).toContain("useAuth()");
    expect(hook).toContain("@workos-inc/authkit-nextjs/components");
    expect(hook).toContain("useMemo(");
  });

  it("PlaceView and CurrentLocationHome use it, and no longer take the person as a prop", () => {
    const stage = readFileSync(
      resolve(__dirname, "../components/weather/PlaceStage.tsx"),
      "utf-8",
    );
    const home = readFileSync(
      resolve(__dirname, "CurrentLocationHome.tsx"),
      "utf-8",
    );
    expect(stage).toContain("useAiUser()");
    expect(home).toContain("useAiUser()");
    expect(stage).not.toMatch(/user: AISummaryUser \| null/);
    expect(home).not.toMatch(/user: AISummaryUser \| null/);
  });
});

describe("the place resolver's first HTML", () => {
  it("is the skeleton and a heading, with no place and no not-found view", async () => {
    vi.useRealTimers();
    const { PlaceResolver } =
      await import("@/components/weather/PlaceResolver");
    const html = renderToString(
      createElement(PlaceResolver, { slug: "sembawang-sg" }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Weather forecast");
    expect(html).not.toContain("Location not found");
    // Nothing is asked on the server: the lookup is an effect.
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── structure ───────────────────────────────────────────────────────────────

/**
 * What the place pages' server render may not import: each of these waits on a
 * session or a database. The file that defines it is not a violation; a page
 * (or a module the page reaches) importing it is.
 */
const WAITS = [
  "getCurrentUser",
  "withAuth",
  "requireUser",
  "seasonWithinBudget",
  "getCachedSeason",
  "getSeasonForDate",
  "getCountryByCode",
];

const SHELL_ENTRIES = [
  "app/page.tsx",
  "app/[location]/page.tsx",
  "lib/local-place.ts",
  "lib/season-local.ts",
];

describe("the place pages' server graph imports nothing that waits", () => {
  const graph = serverGraph(SHELL_ENTRIES);

  it("reaches the modules the pages really use (the guard is not vacuous)", () => {
    const names = graph.map(relativeToSrc);
    expect(names).toContain("app/page.tsx");
    expect(names).toContain("app/[location]/page.tsx");
    expect(names).toContain("lib/local-place.ts");
    expect(names).toContain("lib/season-local.ts");
    expect(names).toContain("lib/seed-seasons.ts");
  });

  it("imports no session, no database season and no country read", () => {
    const offenders: string[] = [];
    for (const file of graph) {
      const rel = relativeToSrc(file);
      for (const { names, spec } of importsOf(file)) {
        for (const name of names) {
          if (WAITS.includes(name)) {
            offenders.push(`${rel} imports ${name} from ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("neither page awaits anything but the request, and the two lookups named below", () => {
    // `params`, `cookies()` and `headers()` are the request itself; the rest
    // is the whole list of what may still be awaited, and why.
    const REQUEST = ["params", "cookies", "headers"];
    const LOOKUPS = [
      "getLocationFromDb", // the home page's cookie naming a place the slug cannot
      "fetchPlaces", // the home page's IP-geo call, for a visitor with no cookie
      "res.json", // that call's body
      "resolveLocationParam", // generateMetadata, for a slug only a lookup can name
      "withinDeadline", // the home page's own bound on the two above
    ];
    for (const file of ["app/[location]/page.tsx", "app/page.tsx"]) {
      const source = readFileSync(resolve(__dirname, "..", file), "utf-8");
      const awaited = [...source.matchAll(/\bawait\s+([\w.]+)/g)].map(
        (m) => m[1],
      );
      for (const what of awaited) {
        expect(
          [...REQUEST, ...LOOKUPS].includes(what),
          `${file} awaits ${what}`,
        ).toBe(true);
      }
    }
    // The place page awaits no lookup in its render at all.
    const place = readFileSync(
      resolve(__dirname, "[location]/page.tsx"),
      "utf-8",
    );
    const render = place.slice(
      place.indexOf("export default async function LocationPage"),
    );
    expect(
      [...render.matchAll(/\bawait\s+([\w.]+)/g)].map((m) => m[1]),
    ).toEqual(["params"]);
  });

  it("no layout between the root and a place page awaits anything (a layout sits above loading.tsx, so its wait is the first byte's)", () => {
    const dir = resolve(__dirname, "[location]");
    const layouts = readdirSync(dir).filter((n) => /^layout\.[jt]sx?$/.test(n));
    for (const name of layouts) {
      const source = readFileSync(resolve(dir, name), "utf-8").replace(
        /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm,
        "",
      );
      expect(source, name).not.toMatch(/\bawait\b/);
    }
  });

  it("the only store lookup left on the home page is for a cookie naming a place the slug cannot", () => {
    const home = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
    expect(home).toContain("localPlaceForSlug(lastLocation) ??");
    expect(home.match(/getLocationFromDb\(/g)?.length).toBe(1);
  });
});
