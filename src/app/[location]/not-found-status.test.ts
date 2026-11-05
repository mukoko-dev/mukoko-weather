/**
 * #237 and #452 — who answers "no such place", and with what status.
 *
 * #237 made an unknown slug a real 404: Next.js can only send a non-200
 * status before the first byte of the shell is flushed, so a `notFound()`
 * thrown under `[location]/loading.tsx`'s Suspense boundary arrives as a 200.
 * The fix was a layout that resolved the slug above that boundary, which put
 * a place lookup (the database, or the Worker) in front of the first byte of
 * EVERY place page.
 *
 * #452 (owner: "an app, a page, a layout, a container has never depended on
 * data") takes it off the critical path. The real 404 for an unknown slug is
 * the edge proxy's (`src/proxy.ts` and `src/lib/location-gate.ts`, tested in
 * proxy.test.ts and location-gate.test.ts), which rewrites it to a
 * server-rendered 404 before any page renders. What is given up, on purpose:
 * a slug the proxy let through (its lookup failed or timed out, or the place
 * lookup only the Worker can make) is no longer 404'd by a layout; its page
 * sends the shell and the BROWSER resolves it, rendering the not-found view
 * with a 200 status and `noindex` when the Worker holds no such place. These
 * tests pin both halves.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSlug } from "@/lib/slug-migration";

const mockGetLocationFromDb = vi.fn();
vi.mock("@/lib/db", () => ({
  getLocationFromDb: (slug: string) => mockGetLocationFromDb(slug),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const appDir = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(appDir, p), "utf-8");

const STORED = {
  slug: "sembawang-sg",
  name: "Sembawang",
  province: "Singapore",
  lat: 1.45,
  lon: 103.82,
  elevation: 15,
  tags: ["city"],
  country: "SG",
};

beforeEach(() => {
  mockGetLocationFromDb.mockReset();
});

describe("[location] has no layout in front of the shell", () => {
  it("has no layout.tsx: no await sits above loading.tsx's boundary", () => {
    expect(existsSync(resolve(appDir, "[location]/layout.tsx"))).toBe(false);
  });

  it("the place page never calls notFound(): it resolves in the browser instead", () => {
    const page = read("[location]/page.tsx");
    expect(page).not.toContain("notFound(");
    expect(page).toContain("<PlaceResolver slug={slug} />");
  });

  it("the edge proxy is still the real 404 for an unknown slug", () => {
    const proxy = read("../proxy.ts");
    expect(proxy).toContain("LOCATION_NOT_FOUND_REWRITE");
    expect(proxy).toContain("isRenderableLocation(");
    expect(existsSync(resolve(appDir, "[location]/loading.tsx"))).toBe(true);
  });
});

describe("shared per-request location loader", () => {
  it("is what the sub-routes and the place page's metadata reach, via resolveLocationParam", () => {
    const shared = readFileSync(
      resolve(appDir, "../lib/load-location.ts"),
      "utf-8",
    );
    expect(shared).toMatch(
      /import \{ loadLocation \} from "@\/app\/\[location\]\/load-location"/,
    );
    const page = read("[location]/page.tsx");
    expect(page).toMatch(
      /import \{ resolveLocationParam \} from "@\/lib\/load-location"/,
    );
    // A second local cache() wrapper would not dedupe with the shared one.
    expect(page).not.toMatch(/const loadLocation = cache/);
  });

  it("is used by every sub-route too, and none of them calls the store itself", () => {
    for (const sub of ["atmosphere", "forecast", "map"]) {
      const src = read(`[location]/${sub}/page.tsx`);
      expect(src).toMatch(
        /import \{ resolveLocationParam \} from "@\/lib\/load-location"/,
      );
      expect(src).not.toMatch(/getLocationFromDb/);
    }
  });

  it("passes the store's answer through for a slug that needs a lookup", async () => {
    mockGetLocationFromDb.mockResolvedValue(STORED);
    const { loadLocation } = await import("./load-location");
    await expect(loadLocation("sembawang-sg")).resolves.toEqual(STORED);
  });

  it("answers a shipped place and a spot without asking the store at all", async () => {
    mockGetLocationFromDb.mockRejectedValue(new Error("must not be asked"));
    const { loadLocation } = await import("./load-location");
    // A shipped place carries its canonical slug (#317), named by either spelling.
    await expect(loadLocation("harare")).resolves.toMatchObject({
      slug: canonicalSlug("harare"),
    });
    await expect(loadLocation(canonicalSlug("harare"))).resolves.toMatchObject({
      name: "Harare",
      province: "Harare",
      slug: canonicalSlug("harare"),
    });
    await expect(loadLocation("some-place--ksy4dd7")).resolves.toMatchObject({
      slug: "some-place--ksy4dd7",
    });
    expect(mockGetLocationFromDb).not.toHaveBeenCalled();
  });
});

describe("no root loading boundary", () => {
  it("has no src/app/loading.tsx (it would stream every route's shell)", () => {
    expect(existsSync(resolve(appDir, "loading.tsx"))).toBe(false);
  });

  it("keeps the home page's loading skeleton inside its own Suspense", () => {
    const home = read("page.tsx");
    expect(home).toMatch(/<Suspense fallback=\{<LocationSkeleton \/>\}>/);
    expect(home).toMatch(/<HomeContent \/>/);
  });
});

describe("not-found UI", () => {
  it("the root boundary renders the LocationNotFound view, and [location] adds no second copy", () => {
    expect(read("not-found.tsx")).toMatch(
      /import \{ LocationNotFound \} from "@\/components\/layout\/LocationNotFound"/,
    );
    expect(read("not-found.tsx")).toMatch(/export default LocationNotFound/);
    // A segment boundary would serialise the whole 404 view a second time into
    // every place page's HTML (about 4 KB); the root one catches the same
    // notFound() calls, and renders the same view.
    expect(existsSync(resolve(appDir, "[location]/not-found.tsx"))).toBe(false);
  });

  it("keeps the existing copy and city suggestions", () => {
    const view = readFileSync(
      resolve(appDir, "../components/layout/LocationNotFound.tsx"),
      "utf-8",
    );
    expect(view).toMatch(/Location not found/);
    expect(view).toMatch(/<CitySuggestions/);
    expect(view).toMatch(/getLocationsForContext\(20\)/);
    const list = readFileSync(
      resolve(appDir, "../components/layout/CitySuggestions.tsx"),
      "utf-8",
    );
    expect(list).toMatch(/Try one of these cities/);
  });

  it("the browser's not-found view has the same copy and list, marks itself noindex and reads no database", () => {
    const view = readFileSync(
      resolve(appDir, "../components/weather/PlaceNotFound.tsx"),
      "utf-8",
    );
    expect(view).toMatch(/Location not found/);
    expect(view).toMatch(/We don't have weather data for that location yet\./);
    expect(view).toMatch(/<CitySuggestions/);
    expect(view).toContain('<meta name="robots" content="noindex" />');
    expect(view).not.toMatch(/@\/lib\/db|getLocationsForContext/);
  });
});
