/**
 * Tests for src/proxy.ts — the lastLocation cookie must only ever be set for
 * location slugs, never for the app's own top-level routes (issue #236).
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { NextRequest, NextResponse } from "next/server";

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
    expect(await lastLocationFor("/harare")).toBe("harare");
  });

  it("uses the first segment of a location sub-route", async () => {
    expect(await lastLocationFor("/harare/forecast")).toBe("harare");
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
    "/harare",
    "/harare/forecast",
    "/nairobi-ke",
    "/some-place--ksy4dd7",
    "/community-place-a1b2c3",
  ])("lets the renderable location %s through", async (path) => {
    expect(await rewriteFor(path)).toBeNull();
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
    ["/Harare", "/harare"],
    ["/Nairobi-KE/forecast?x=1", "/nairobi-ke/forecast?x=1"],
    ["/harare/Forecast", "/harare/forecast"],
  ])(
    "redirects %s to its lowercase URL %s with a 308",
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
      new NextRequest("https://weather.mukoko.com/harare"),
    );
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContain("wos-session=fresh; Path=/");
    expect(cookies.some((c) => c.startsWith("lastLocation=harare;"))).toBe(
      true,
    );
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
