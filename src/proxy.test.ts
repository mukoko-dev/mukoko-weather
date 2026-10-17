/**
 * Tests for src/proxy.ts — the lastLocation cookie must only ever be set for
 * location slugs, never for the app's own top-level routes (issue #236).
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { NextRequest, NextResponse } from "next/server";
import { canonicalSlug } from "@/lib/slug-migration";
import { SEED_SLUG_TABLE } from "@/lib/slug-migration-data";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  authkit: vi.fn(async () => ({ headers: new Headers() })),
  handleAuthkitProxy: vi.fn(
    (
      _req: unknown,
      headers: Headers,
      opts?: { redirect?: URL; redirectStatus?: 307 | 308 },
    ) => {
      const res = opts?.redirect
        ? NextResponse.redirect(opts.redirect, opts.redirectStatus)
        : NextResponse.next();
      // Like the real helper, AuthKit's cookies are appended afterwards.
      for (const c of headers.getSetCookie())
        res.headers.append("set-cookie", c);
      return res;
    },
  ),
}));

// The location gate's lookup (#263). Only slugs that are neither seed slugs
// nor smart-slug spots reach it; "community-place-a1b2c3" stands in for a
// real community record, "db-down" for a failed lookup.
const mockResolve = vi.fn(
  async (slug: string, _opts?: { strict?: boolean }) => {
    if (slug === "community-place-a1b2c3") return { slug };
    // A platform slug resolves to a place whose canonical slug differs.
    if (slug === "old-town-a1b2c3") return { slug: "old-town--ksy4dd7" };
    if (slug === "db-down") throw new Error("mongo down");
    return null;
  },
);
vi.mock("@/lib/places", () => ({
  resolveLocationSlug: (slug: string, opts?: { strict?: boolean }) =>
    mockResolve(slug, opts),
}));

const { default: proxy } = await import("./proxy");
const { authkit } = await import("@workos-inc/authkit-nextjs");
const { resetLocationGateCache } = await import("@/lib/location-gate");
const { resetBareNameCache } = await import("@/lib/bare-name");
const { buildSmartSlug } = await import("@/lib/smart-slug");

/** The geocoder behind /api/py/search?mode=resolve, stubbed (#317). Every
 * test starts with "nothing found", so the 404 tests below are unaffected. */
const mockResolveFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
  Response.json({
    locations: [],
    total: 0,
    source: "none",
    resolve: "no_match",
  }),
);
beforeEach(() => {
  mockResolveFetch.mockClear();
  vi.stubEnv("NEXT_PUBLIC_WEATHER_API_URL", "https://weather-api.test");
  vi.stubGlobal("fetch", mockResolveFetch);
  resetBareNameCache();
});

const APP_DIR = resolve(__dirname, "app");

/** Every top-level route directory under src/app, minus the dynamic slug. */
const topLevelRoutes = readdirSync(APP_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => !/^[[(_@]/.test(name));

async function lastLocationFor(path: string): Promise<string | undefined> {
  const res = await proxy(new NextRequest(`https://weather.mukoko.com${path}`));
  // Read the raw headers: the proxy appends this cookie rather than setting
  // it through `res.cookies` (see the AuthKit session test below).
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("lastLocation="));
  return cookie?.slice("lastLocation=".length).split(";")[0];
}

describe("proxy — lastLocation cookie", () => {
  it("finds the app's top-level routes", () => {
    expect(topLevelRoutes).toEqual(
      expect.arrayContaining(["profile", "developers", "explore", "api"]),
    );
  });

  it.each(topLevelRoutes)("never sets lastLocation for /%s", async (route) => {
    expect(await lastLocationFor(`/${route}`)).toBeUndefined();
  });

  it.each(["/profile", "/developers", "/developers/keys"])(
    "leaves lastLocation alone on %s (issue #236)",
    async (path) => {
      expect(await lastLocationFor(path)).toBeUndefined();
    },
  );

  it("sets lastLocation for a location slug", async () => {
    expect(await lastLocationFor("/some-place--ksy4dd7")).toBe(
      "some-place--ksy4dd7",
    );
    // A canonical seed slug is a plain location page.
    expect(await lastLocationFor(`/${canonicalSlug("harare")}`)).toBe(
      canonicalSlug("harare"),
    );
  });

  it("uses the first segment of a location sub-route", async () => {
    expect(await lastLocationFor("/some-place--ksy4dd7/forecast")).toBe(
      "some-place--ksy4dd7",
    );
  });

  it("does not set lastLocation on the home page", async () => {
    expect(await lastLocationFor("/")).toBeUndefined();
  });
});

describe("WeatherLoadingScene — KNOWN_ROUTES covers every page route", () => {
  const sceneSource = readFileSync(
    resolve(__dirname, "components/weather/WeatherLoadingScene.tsx"),
    "utf-8",
  );
  const block = sceneSource.match(/KNOWN_ROUTES = new Set\(\[([\s\S]*?)\]\)/);
  const listed = new Set(
    [...(block?.[1] ?? "").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]),
  );
  const pageRoutes = topLevelRoutes.filter((route) => {
    try {
      return readdirSync(resolve(APP_DIR, route)).includes("page.tsx");
    } catch {
      return false;
    }
  });

  it.each(pageRoutes)("lists /%s", (route) => {
    expect(listed.has(route)).toBe(true);
  });
});

describe("proxy — unknown location slugs get a server-rendered 404 (#263)", () => {
  const REWRITE = "/__mukoko/location/not-found";

  beforeEach(() => resetLocationGateCache());

  async function rewriteFor(path: string): Promise<string | null> {
    const res = await proxy(
      new NextRequest(`https://weather.mukoko.com${path}`),
    );
    const target = res.headers.get("x-middleware-rewrite");
    return target ? new URL(target).pathname : null;
  }

  it.each(["/zzzz-not-a-place", "/pricing", "/zzzz/forecast", "/pricing/map"])(
    "rewrites %s to the unmatched not-found path",
    async (path) => {
      expect(await rewriteFor(path)).toBe(REWRITE);
    },
  );

  it.each([
    `/${canonicalSlug("harare")}`,
    `/${canonicalSlug("harare")}/forecast`,
    `/${canonicalSlug("nairobi-ke")}`,
    "/some-place--ksy4dd7",
    "/community-place-a1b2c3",
  ])("lets the renderable location %s through", async (path) => {
    expect(await rewriteFor(path)).toBeNull();
    const res = await proxy(
      new NextRequest(`https://weather.mukoko.com${path}`),
    );
    expect(res.status).toBe(200);
  });

  describe("canonical slugs (#317)", () => {
    const go = (path: string) =>
      proxy(new NextRequest(`https://weather.mukoko.com${path}`));
    const to = (res: Response) => {
      const loc = new URL(res.headers.get("location") ?? "");
      return loc.pathname + loc.search;
    };

    it("308s a legacy seed slug to its canonical slug with no lookup", async () => {
      mockResolve.mockClear();
      const res = await go("/nairobi-ke");
      expect(res.status).toBe(308);
      expect(to(res)).toBe(`/${canonicalSlug("nairobi-ke")}`);
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it("308s EVERY shipped legacy slug in one hop, and the target renders (no loop)", async () => {
      mockResolve.mockClear();
      for (const [legacy, canonical] of SEED_SLUG_TABLE) {
        const res = await go(`/${legacy}`);
        expect(res.status, legacy).toBe(308);
        expect(to(res)).toBe(`/${canonical}`);
        const landed = await go(to(res));
        expect(landed.status, canonical).toBe(200);
        expect(landed.headers.get("location")).toBeNull();
      }
      // The whole table is answered with no lookup.
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it("keeps every sub-route and the query string for every legacy slug", async () => {
      for (const [legacy, canonical] of SEED_SLUG_TABLE) {
        for (const sub of ["forecast", "atmosphere", "map", "agriculture"]) {
          const res = await go(`/${legacy}/${sub}?a=1&b=two`);
          expect(res.status).toBe(308);
          expect(to(res)).toBe(`/${canonical}/${sub}?a=1&b=two`);
        }
      }
    });

    it("keeps the sub-route and the query string", async () => {
      const res = await go("/harare/atmosphere?units=imperial&x=1");
      expect(res.status).toBe(308);
      expect(to(res)).toBe(
        `/${canonicalSlug("harare")}/atmosphere?units=imperial&x=1`,
      );
    });

    it("does not set lastLocation on the redirect (the canonical URL does)", async () => {
      const res = await go("/harare");
      expect(
        res.headers.getSetCookie().some((c) => c.startsWith("lastLocation=")),
      ).toBe(false);
    });

    it("308s a platform slug to the canonical slug its place resolves to", async () => {
      resetLocationGateCache();
      const res = await go("/old-town-a1b2c3/forecast?x=1");
      expect(res.status).toBe(308);
      expect(to(res)).toBe("/old-town--ksy4dd7/forecast?x=1");
      // Cached: the second request redirects without another lookup.
      mockResolve.mockClear();
      const again = await go("/old-town-a1b2c3");
      expect(again.status).toBe(308);
      expect(to(again)).toBe("/old-town--ksy4dd7");
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it("never redirects a slug that is already canonical (no loop)", async () => {
      const res = await go("/old-town--ksy4dd7");
      expect(res.status).toBe(200);
      const community = await go("/community-place-a1b2c3");
      expect(community.status).toBe(200);
    });

    it("tidies a legacy lastLocation cookie on the home page, once", async () => {
      const req = new NextRequest("https://weather.mukoko.com/", {
        headers: { cookie: "lastLocation=harare" },
      });
      const res = await proxy(req);
      const set = res.headers
        .getSetCookie()
        .find((c) => c.startsWith("lastLocation="));
      expect(set?.split(";")[0]).toBe(
        `lastLocation=${canonicalSlug("harare")}`,
      );
      const canonical = await proxy(
        new NextRequest("https://weather.mukoko.com/", {
          headers: { cookie: `lastLocation=${canonicalSlug("harare")}` },
        }),
      );
      expect(
        canonical.headers
          .getSetCookie()
          .some((c) => c.startsWith("lastLocation=")),
      ).toBe(false);
    });
  });

  it("never looks up seed slugs or smart-slug spots", async () => {
    mockResolve.mockClear();
    await rewriteFor("/harare");
    await rewriteFor("/some-place--ksy4dd7/map");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("asks the resolver in strict mode, so a DB error isn't read as not found", async () => {
    resetLocationGateCache();
    mockResolve.mockClear();
    await rewriteFor("/community-place-a1b2c3");
    expect(mockResolve).toHaveBeenCalledWith("community-place-a1b2c3", {
      strict: true,
    });
  });

  it.each([
    ["/Some-Place--ksy4dd7", "/some-place--ksy4dd7"],
    ["/Some-Place--ksy4dd7/Forecast?x=1", "/some-place--ksy4dd7/forecast?x=1"],
    // A legacy seed slug in the wrong case: one hop, straight to canonical.
    ["/Harare", `/${canonicalSlug("harare")}`],
    [
      "/Nairobi-KE/forecast?x=1",
      `/${canonicalSlug("nairobi-ke")}/forecast?x=1`,
    ],
    ["/harare/Forecast", `/${canonicalSlug("harare")}/forecast`],
  ])(
    "redirects %s to its canonical URL %s with a 308",
    async (path, target) => {
      const res = await proxy(
        new NextRequest(`https://weather.mukoko.com${path}`),
      );
      expect(res.status).toBe(308);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.pathname + loc.search).toBe(target);
    },
  );

  it("lets the request through when the lookup fails", async () => {
    expect(await rewriteFor("/db-down")).toBeNull();
  });

  it.each(["/", "/profile", "/developers/keys", "/explore/city", "/a/b/c"])(
    "leaves non-location path %s alone",
    async (path) => {
      expect(await rewriteFor(path)).toBeNull();
    },
  );

  it("keeps the lastLocation cookie behaviour unchanged for unknown slugs", async () => {
    // Deliberately unchanged here: whether a 404 slug should overwrite the
    // cookie is an open owner decision (#238).
    expect(await lastLocationFor("/pricing")).toBe("pricing");
  });

  it("hands a slow lookup to event.waitUntil so it can still cache", async () => {
    vi.useFakeTimers();
    try {
      mockResolve.mockImplementationOnce(() => new Promise(() => {}));
      const waitUntil = vi.fn();
      const pending = proxy(
        new NextRequest("https://weather.mukoko.com/slow-place-a1b2c3"),
        { waitUntil } as never,
      );
      await vi.advanceTimersByTimeAsync(3000);
      await pending;
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds the not-found rewrite from handleAuthkitProxy's own response", async () => {
    // Session cookies and the forwarded request headers come straight from
    // the library (so its PKCE handling applies); only the next() marker is
    // swapped for the rewrite.
    const headers = new Headers();
    headers.append("set-cookie", "wos-session=s; Path=/");
    vi.mocked(authkit).mockResolvedValueOnce({ headers } as never);
    const res = await proxy(
      new NextRequest("https://weather.mukoko.com/zzzz-not-a-place"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toContain(REWRITE);
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(res.headers.getSetCookie()).toContain("wos-session=s; Path=/");
  });

  it("passes an AuthKit redirect through instead of turning it into a rewrite", async () => {
    const { handleAuthkitProxy } = await import("@workos-inc/authkit-nextjs");
    vi.mocked(handleAuthkitProxy).mockReturnValueOnce(
      NextResponse.redirect("https://auth.example/sign-in", 307),
    );
    const res = await proxy(
      new NextRequest("https://weather.mukoko.com/zzzz-not-a-place"),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("keeps AuthKit's refreshed session cookie next to lastLocation", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "wos-session=fresh; Path=/");
    vi.mocked(authkit).mockResolvedValueOnce({ headers } as never);
    const res = await proxy(
      new NextRequest("https://weather.mukoko.com/some-place--ksy4dd7"),
    );
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContain("wos-session=fresh; Path=/");
    expect(
      cookies.some((c) => c.startsWith("lastLocation=some-place--ksy4dd7;")),
    ).toBe(true);
  });

  it("rewrites to a path no app route matches", () => {
    const [first] = REWRITE.split("/").filter(Boolean);
    expect(topLevelRoutes).not.toContain(first);
    // Three segments: deeper than /[location]/<sub>, and the first segment
    // is not "explore" (the only three-segment route tree).
    expect(REWRITE.split("/").filter(Boolean)).toHaveLength(3);
    expect(first).not.toBe("explore");
  });
});

describe("proxy — paused /shamwari is a real 404 (production drift)", () => {
  it.each(["/shamwari", "/shamwari/anything"])(
    "rewrites %s to the not-found path while FLAGS.shamwari_chat is off",
    async (path) => {
      const res = await proxy(
        new NextRequest(`https://weather.mukoko.com${path}`),
      );
      expect(res.headers.get("x-middleware-rewrite")).toContain(
        "/__mukoko/location/not-found",
      );
    },
  );

  it("does not rewrite other routes", async () => {
    const res = await proxy(
      new NextRequest("https://weather.mukoko.com/about"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("proxy — bare place names resolve instead of 404 (#317)", () => {
  const SAMUI = buildSmartSlug("Ko Samui", 9.51201, 100.01361);

  beforeEach(() => resetLocationGateCache());

  function found(slug: string = SAMUI) {
    mockResolveFetch.mockResolvedValueOnce(
      Response.json({ locations: [{ slug }], total: 1, resolve: "ok" }),
    );
  }

  async function run(path: string) {
    return proxy(new NextRequest(`https://weather.mukoko.com${path}`));
  }

  it("308-redirects an unknown bare name to its canonical spot slug", async () => {
    found();
    const res = await run("/koh-samui");
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe(
      `/${SAMUI}`,
    );
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("asks the Worker's search in resolve mode with the spaced name", async () => {
    found();
    await run("/koh-samui");
    const url = new URL(mockResolveFetch.mock.calls[0][0]);
    expect(url.origin).toBe("https://weather-api.test");
    expect(url.pathname).toBe("/v1/search");
    expect(url.searchParams.get("mode")).toBe("resolve");
    expect(url.searchParams.get("q")).toBe("koh samui");
  });

  it("keeps the sub-route and the query string", async () => {
    found();
    const res = await run("/koh-samui/forecast?units=imperial");
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.pathname + loc.search).toBe(`/${SAMUI}/forecast?units=imperial`);
  });

  it("sets no lastLocation cookie on the redirect, and caches it privately", async () => {
    found();
    const res = await run("/koh-samui");
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith("lastLocation=")),
    ).toBe(false);
    expect(res.headers.get("cache-control")).toBe("private, max-age=600");
  });

  it("serves the second request from the per-instance cache", async () => {
    found();
    await run("/koh-samui");
    resetLocationGateCache();
    const again = await run("/koh-samui");
    expect(again.status).toBe(308);
    expect(mockResolveFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the server-rendered 404 when nothing is found", async () => {
    const res = await run("/chiang-rai-zzz");
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/__mukoko/location/not-found",
    );
    expect(res.status).not.toBe(308);
  });

  it("falls back to the 404 when the geocoder is over budget, then backs off", async () => {
    mockResolveFetch.mockResolvedValueOnce(
      Response.json({ locations: [], resolve: "over_budget" }),
    );
    const res = await run("/lake-kariba-zzz");
    expect(res.headers.get("x-middleware-rewrite")).toContain("not-found");
    await run("/another-name-zzz");
    expect(mockResolveFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the 404 when the lookup fails", async () => {
    mockResolveFetch.mockRejectedValueOnce(new Error("network"));
    const res = await run("/lake-kariba-zzz");
    expect(res.headers.get("x-middleware-rewrite")).toContain("not-found");
  });

  it("never follows a redirect target that is not a seed or a spot", async () => {
    found("some-community-record");
    const res = await run("/koh-samui");
    expect(res.status).not.toBe(308);
    expect(res.headers.get("x-middleware-rewrite")).toContain("not-found");
  });

  it.each(["/admin", "/wp-login", "/12345", "/pricing/map"])(
    "never geocodes %s",
    async (path) => {
      await run(path);
      expect(mockResolveFetch).not.toHaveBeenCalled();
    },
  );

  it("never geocodes seeds, spots, known places or a failed lookup", async () => {
    await run("/harare");
    await run("/some-place--ksy4dd7");
    await run("/community-place-a1b2c3");
    await run("/db-down");
    expect(mockResolveFetch).not.toHaveBeenCalled();
  });

  it("is off (a plain 404) while the Worker is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEATHER_API_URL", "");
    const res = await run("/koh-samui");
    expect(res.headers.get("x-middleware-rewrite")).toContain("not-found");
    expect(mockResolveFetch).not.toHaveBeenCalled();
  });

  it("keeps the case redirect and the seed-alias redirect as they were", async () => {
    const upper = await run("/Harare");
    expect(new URL(upper.headers.get("location") ?? "").pathname).toBe(
      `/${canonicalSlug("harare")}`,
    );
    const alias = await run("/phuket");
    expect(new URL(alias.headers.get("location") ?? "").pathname).toBe(
      `/${canonicalSlug("phuket-th")}`,
    );
    expect(mockResolveFetch).not.toHaveBeenCalled();
  });

  it("keeps the session cookie AuthKit refreshed on the redirect", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "wos-session=fresh; Path=/");
    vi.mocked(authkit).mockResolvedValueOnce({ headers } as never);
    found();
    const res = await run("/koh-samui");
    expect(res.headers.getSetCookie()).toContain("wos-session=fresh; Path=/");
  });

  it("hands a slow geocoder to event.waitUntil and still 404s", async () => {
    vi.useFakeTimers();
    try {
      mockResolveFetch.mockImplementationOnce(() => new Promise(() => {}));
      const waitUntil = vi.fn();
      const pending = proxy(
        new NextRequest("https://weather.mukoko.com/slow-name-zzz"),
        { waitUntil } as never,
      );
      await vi.advanceTimersByTimeAsync(5000);
      const res = await pending;
      expect(res.headers.get("x-middleware-rewrite")).toContain("not-found");
      expect(waitUntil).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
