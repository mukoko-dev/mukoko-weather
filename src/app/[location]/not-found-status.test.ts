/**
 * #237 — an unknown slug must answer a real 404, not a streamed 200
 * "Location not found".
 *
 * Next.js can only send a non-200 status before the first byte of the shell
 * is flushed. Any Suspense boundary above the code that calls notFound()
 * flushes that shell early, so these tests pin the two things that keep the
 * status real:
 *   1. `[location]/layout.tsx` resolves the slug and calls notFound() itself,
 *      above `[location]/loading.tsx`'s boundary.
 *   2. There is no root `src/app/loading.tsx` — a root boundary wraps every
 *      route, the `[location]` layout included. The home page carries its own
 *      Suspense instead.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOT_FOUND = new Error("NEXT_NOT_FOUND");

const mockGetLocationFromDb = vi.fn();
vi.mock("@/lib/db", () => ({
  getLocationFromDb: (slug: string) => mockGetLocationFromDb(slug),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

const appDir = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(appDir, p), "utf-8");

const HARARE = {
  slug: "harare",
  name: "Harare",
  province: "Harare",
  lat: -17.83,
  lon: 31.05,
  elevation: 1490,
  tags: ["city"],
  country: "ZW",
};

beforeEach(() => {
  mockGetLocationFromDb.mockReset();
});

describe("[location] layout — real 404 for unknown slugs", () => {
  async function render(slug: string) {
    const { default: LocationLayout } = await import("./layout");
    return LocationLayout({
      children: "page",
      params: Promise.resolve({ location: slug }),
    });
  }

  it("calls notFound() when the slug does not resolve", async () => {
    mockGetLocationFromDb.mockResolvedValue(null);
    await expect(render("zzzz-not-a-place")).rejects.toBe(NOT_FOUND);
    await expect(render("pricing")).rejects.toBe(NOT_FOUND);
  });

  it("renders the page for a resolvable slug (seed or smart slug)", async () => {
    mockGetLocationFromDb.mockResolvedValue(HARARE);
    await expect(render("harare")).resolves.toBe("page");
    await expect(render("some-place--ksy4dd7")).resolves.toBe("page");
  });

  it("treats a resolver error as not found instead of crashing the route", async () => {
    mockGetLocationFromDb.mockRejectedValue(new Error("mongo down"));
    await expect(render("harare")).rejects.toBe(NOT_FOUND);
  });

  it("checks the slug before rendering children, outside loading.tsx", () => {
    const layout = read("[location]/layout.tsx");
    expect(layout).toMatch(/await loadLocation\(slug\)/);
    expect(layout).toMatch(/notFound\(\)/);
    expect(layout).not.toMatch(/<Suspense/);
  });
});

describe("shared per-request location loader", () => {
  it("is the one loadLocation the layout and page both import", () => {
    expect(read("[location]/layout.tsx")).toMatch(
      /import \{ loadLocation \} from "\.\/load-location"/,
    );
    const page = read("[location]/page.tsx");
    expect(page).toMatch(/import \{ loadLocation \} from "\.\/load-location"/);
    // A second local cache() wrapper would not dedupe with the layout's.
    expect(page).not.toMatch(/const loadLocation = cache/);
  });

  it("passes the resolver result through", async () => {
    mockGetLocationFromDb.mockResolvedValue(HARARE);
    const { loadLocation } = await import("./load-location");
    await expect(loadLocation("harare")).resolves.toEqual(HARARE);
  });
});

describe("no root loading boundary", () => {
  it("has no src/app/loading.tsx (it would stream every route's shell)", () => {
    expect(existsSync(resolve(appDir, "loading.tsx"))).toBe(false);
  });

  it("keeps the home page's loading scene inside its own Suspense", () => {
    const home = read("page.tsx");
    expect(home).toMatch(/<Suspense fallback=\{<WeatherLoadingScene \/>\}>/);
    expect(home).toMatch(/<HomeContent \/>/);
  });
});

describe("not-found UI", () => {
  it("root and [location] boundaries render the same LocationNotFound view", () => {
    for (const file of ["not-found.tsx", "[location]/not-found.tsx"]) {
      expect(read(file)).toMatch(
        /import \{ LocationNotFound \} from "@\/components\/layout\/LocationNotFound"/,
      );
      expect(read(file)).toMatch(/export default LocationNotFound/);
    }
  });

  it("keeps the existing copy and city suggestions", () => {
    const view = readFileSync(
      resolve(appDir, "../components/layout/LocationNotFound.tsx"),
      "utf-8",
    );
    expect(view).toMatch(/Location not found/);
    expect(view).toMatch(/Try one of these cities/);
    expect(view).toMatch(/getLocationsForContext\(20\)/);
  });
});
