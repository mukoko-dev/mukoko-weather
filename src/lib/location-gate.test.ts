/**
 * Location gate (#263) — decides in the proxy whether `/{slug}` renders.
 */
import { readdirSync } from "fs";
import { resolve as resolvePath } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCATIONS } from "./locations";
import { slugifyName } from "./smart-slug";
import {
  DEGRADED_BACKOFF_MS,
  TIMEOUTS_BEFORE_BACKOFF,
  KNOWN_TTL_MS,
  LOCATION_SUB_ROUTES,
  MAX_KNOWN,
  MAX_UNKNOWN,
  SEED_NAME_ALIASES,
  UNKNOWN_TTL_MS,
  classifyLocationPath,
  isRenderableLocation,
  rendersWithoutLookup,
  resetLocationGateCache,
} from "./location-gate";

const KNOWN = new Set(["explore", "api", "profile", "auth"]);

beforeEach(() => resetLocationGateCache());

describe("classifyLocationPath", () => {
  it.each([
    ["/harare", "harare"],
    ["/harare/forecast", "harare"],
    ["/harare/atmosphere", "harare"],
    ["/harare/agriculture", "harare"],
    ["/harare/map", "harare"],
    ["/some-place--ksy4dd7", "some-place--ksy4dd7"],
  ])("%s is the location page for %s", (path, slug) => {
    expect(classifyLocationPath(path, KNOWN)).toEqual({ kind: "slug", slug });
  });

  it.each([
    "/",
    "/explore",
    "/explore/city",
    "/api/py/status",
    "/profile",
    "/harare/other",
    "/a/b/c",
  ])("%s is not a location page", (path) => {
    expect(classifyLocationPath(path, KNOWN)).toEqual({ kind: "other" });
  });

  it.each([
    "/_not-found",
    "/__nextjs_original-stack-frame",
    "/~offline",
    "/bad%E0%A4%A",
    "/%65xplore",
  ])("leaves %s to the page", (path) => {
    expect(classifyLocationPath(path, KNOWN)).toEqual({ kind: "other" });
  });

  it.each([
    ["/x_y", "x_y"],
    ["/x%20y", "x y"],
    ["/z%C3%BCrich", "zürich"],
  ])(
    "looks up %s as the page would see it (%s), since its name lookup can match",
    (path, slug) => {
      expect(classifyLocationPath(path, KNOWN)).toEqual({ kind: "slug", slug });
    },
  );

  it("404s a segment longer than any slug without a lookup", () => {
    expect(classifyLocationPath(`/${"a".repeat(201)}`, KNOWN)).toEqual({
      kind: "unknown",
    });
  });

  it("still gates an over-long lowercase slug (the lookup says unknown)", () => {
    const slug = "a".repeat(83);
    expect(classifyLocationPath(`/${slug}`, KNOWN)).toEqual({
      kind: "slug",
      slug,
    });
  });

  it.each([
    ["/Harare", "/harare"],
    ["/Nairobi-KE", "/nairobi-ke"],
    ["/Harare/Forecast", "/harare/forecast"],
    ["/harare/Forecast", "/harare/forecast"],
    ["/HARARE/forecast", "/harare/forecast"],
    ["/Z%C3%BCrich", "/z%C3%BCrich"],
    ["/Explore", "/explore"],
  ])("%s in the wrong case redirects to %s", (path, location) => {
    expect(classifyLocationPath(path, KNOWN)).toEqual({
      kind: "redirect",
      location,
    });
  });

  it("lists exactly the sub-route directories under src/app/[location]", () => {
    const dir = resolvePath(__dirname, "../app/[location]");
    const subRoutes = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect([...LOCATION_SUB_ROUTES].sort()).toEqual(subRoutes);
  });
});

describe("rendersWithoutLookup", () => {
  it("accepts shipped seed slugs (advertised means renderable)", () => {
    expect(rendersWithoutLookup("harare")).toBe(true);
    expect(rendersWithoutLookup("gweru")).toBe(true);
    expect(rendersWithoutLookup("nairobi-ke")).toBe(true);
  });

  it("accepts smart-slug spots, which carry their own coordinate", () => {
    expect(rendersWithoutLookup("some-place--ksy4dd7")).toBe(true);
  });

  it("needs a lookup for OSM place refs and everything else", () => {
    expect(rendersWithoutLookup("canberra-residences--osm-w890123")).toBe(
      false,
    );
    expect(rendersWithoutLookup("harare-a1b2c3")).toBe(false);
    expect(rendersWithoutLookup("pricing")).toBe(false);
  });
});

describe("isRenderableLocation", () => {
  it("never calls the resolver for seed slugs or spots", async () => {
    const resolve = vi.fn();
    expect(await isRenderableLocation("harare", resolve)).toBe(true);
    expect(await isRenderableLocation("x--ksy4dd7", resolve)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("is true when the resolver finds the slug and false when it doesn't", async () => {
    expect(await isRenderableLocation("harare-a1b2c3", async () => ({}))).toBe(
      true,
    );
    expect(await isRenderableLocation("pricing", async () => null)).toBe(false);
  });

  it("returns null (let it through) when the lookup throws, then backs off", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("down");
    });
    const t0 = 1_000;
    expect(
      await isRenderableLocation("harare-a1b2c3", resolve, { now: t0 }),
    ).toBeNull();
    // Inside the backoff: no second lookup on a struggling cluster.
    expect(
      await isRenderableLocation("other-a1b2c3", resolve, {
        now: t0 + DEGRADED_BACKOFF_MS - 1,
      }),
    ).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    // After it: the failure wasn't cached, so the slug is looked up again.
    resolve.mockImplementation(async () => ({}) as never);
    expect(
      await isRenderableLocation("harare-a1b2c3", resolve, {
        now: t0 + DEGRADED_BACKOFF_MS + 1,
      }),
    ).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("shares one lookup between concurrent requests for a slug", async () => {
    let settle: (v: unknown) => void = () => {};
    const resolve = vi.fn(
      () =>
        new Promise((r) => {
          settle = r;
        }),
    );
    const a = isRenderableLocation("busy-a1b2c3", resolve);
    const b = isRenderableLocation("busy-a1b2c3", resolve);
    settle({});
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("hands a lookup that outlives the timeout to keepAlive", async () => {
    vi.useFakeTimers();
    try {
      const keepAlive = vi.fn();
      const pending = isRenderableLocation(
        "slow-a1b2c3",
        () => new Promise(() => {}),
        { now: 0, timeoutMs: 50, keepAlive },
      );
      await vi.advanceTimersByTimeAsync(51);
      expect(await pending).toBeNull();
      expect(keepAlive).toHaveBeenCalledTimes(1);
      expect(keepAlive.mock.calls[0][0]).toBeInstanceOf(Promise);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't back off after a timeout (a cold first connection is healthy)", async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(() => new Promise(() => {}));
      const first = isRenderableLocation("a-a1b2c3", resolve, {
        now: 0,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(51);
      expect(await first).toBeNull();
      const second = isRenderableLocation("b-a1b2c3", resolve, {
        now: 1,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(51);
      await second;
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a slow lookup through, then caches its late answer", async () => {
    vi.useFakeTimers();
    try {
      let settle: (v: unknown) => void = () => {};
      const resolve = vi.fn(
        () =>
          new Promise((r) => {
            settle = r;
          }),
      );
      const pending = isRenderableLocation("slow-a1b2c3", resolve, {
        now: 0,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(51);
      expect(await pending).toBeNull();
      settle(null); // the lookup finishes after the timeout: not found
      await vi.advanceTimersByTimeAsync(0);
      expect(
        await isRenderableLocation("slow-a1b2c3", resolve, {
          now: 0,
          timeoutMs: 50,
        }),
      ).toBe(false);
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when the lookup hangs past the timeout, and doesn't start a second lookup", async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(() => new Promise(() => {}));
      const pending = isRenderableLocation("harare-a1b2c3", resolve, {
        now: 0,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(51);
      expect(await pending).toBeNull();
      const again = isRenderableLocation("harare-a1b2c3", resolve, {
        now: 0,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(51);
      await again;
      // Still running: the next request shares it instead of piling on.
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off after consecutive timeouts, so a hung cluster doesn't stall every request", async () => {
    vi.useFakeTimers();
    try {
      // A lookup has answered, so the connection is known to work.
      await isRenderableLocation("warm-a1b2c3", async () => ({}), { now: 0 });
      const resolve = vi.fn(() => new Promise(() => {}));
      for (let i = 0; i < TIMEOUTS_BEFORE_BACKOFF; i++) {
        const p = isRenderableLocation(`hang-${i}-a1b2c3`, resolve, {
          now: 0,
          timeoutMs: 50,
        });
        await vi.advanceTimersByTimeAsync(51);
        expect(await p).toBeNull();
      }
      expect(
        await isRenderableLocation("next-a1b2c3", resolve, {
          now: 100,
          timeoutMs: 50,
        }),
      ).toBeNull();
      expect(resolve).toHaveBeenCalledTimes(TIMEOUTS_BEFORE_BACKOFF);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't back off when cold-start lookups time out together", async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(() => new Promise(() => {}));
      const waits = [
        isRenderableLocation("cold-a-a1b2c3", resolve, {
          now: 0,
          timeoutMs: 50,
        }),
        isRenderableLocation("cold-a-a1b2c3", resolve, {
          now: 0,
          timeoutMs: 50,
        }),
        isRenderableLocation("cold-b-a1b2c3", resolve, {
          now: 0,
          timeoutMs: 50,
        }),
      ];
      await vi.advanceTimersByTimeAsync(51);
      await Promise.all(waits);
      resolve.mockClear();
      const next = isRenderableLocation("cold-c-a1b2c3", resolve, {
        now: 60,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(51);
      await next;
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off from when a slow failure settles, not when it started", async () => {
    vi.useFakeTimers();
    try {
      let fail: (e: unknown) => void = () => {};
      const resolve = vi.fn(
        () =>
          new Promise((_, rej) => {
            fail = rej;
          }),
      );
      const p = isRenderableLocation("slow-fail-a1b2c3", resolve, {
        now: 0,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(51);
      expect(await p).toBeNull();
      await vi.advanceTimersByTimeAsync(30_000); // driver gives up after 30 s
      fail(new Error("server selection timed out"));
      await vi.advanceTimersByTimeAsync(0);
      resolve.mockClear();
      expect(
        await isRenderableLocation("other-a1b2c3", resolve, {
          now: 30_051 + DEGRADED_BACKOFF_MS - 1,
        }),
      ).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches answers, negatives for less time than positives", async () => {
    const resolve = vi.fn(async (slug: string) =>
      slug === "real-a1b2c3" ? {} : null,
    );
    const t0 = 1_000_000;
    await isRenderableLocation("real-a1b2c3", resolve, { now: t0 });
    await isRenderableLocation("nope", resolve, { now: t0 });
    expect(resolve).toHaveBeenCalledTimes(2);

    await isRenderableLocation("real-a1b2c3", resolve, {
      now: t0 + UNKNOWN_TTL_MS - 1,
    });
    await isRenderableLocation("nope", resolve, {
      now: t0 + UNKNOWN_TTL_MS - 1,
    });
    expect(resolve).toHaveBeenCalledTimes(2);

    // The negative expires first, so a just-created place stops 404ing quickly.
    await isRenderableLocation("nope", resolve, {
      now: t0 + UNKNOWN_TTL_MS + 1,
    });
    expect(resolve).toHaveBeenCalledTimes(3);
    await isRenderableLocation("real-a1b2c3", resolve, {
      now: t0 + KNOWN_TTL_MS + 1,
    });
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(UNKNOWN_TTL_MS).toBeLessThan(KNOWN_TTL_MS);
  });

  it("junk slugs can't evict cached real places", async () => {
    const resolve = vi.fn(async (slug: string) =>
      slug === "real-a1b2c3" ? {} : null,
    );
    await isRenderableLocation("real-a1b2c3", resolve, { now: 5 });
    for (let i = 0; i < MAX_UNKNOWN * 3; i++) {
      await isRenderableLocation(`junk-${i}`, resolve, { now: 5 });
    }
    resolve.mockClear();
    expect(await isRenderableLocation("real-a1b2c3", resolve, { now: 5 })).toBe(
      true,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps each bucket bounded, evicting the oldest entry", async () => {
    const resolve = vi.fn(async () => ({}));
    for (let i = 0; i <= MAX_KNOWN; i++)
      await isRenderableLocation(`p-${i}`, resolve, { now: 5 });
    resolve.mockClear();
    await isRenderableLocation(`p-${MAX_KNOWN}`, resolve, { now: 5 }); // newest, cached
    expect(resolve).not.toHaveBeenCalled();
    await isRenderableLocation("p-0", resolve, { now: 5 }); // oldest, evicted
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("refreshing an expired entry doesn't evict a live one", async () => {
    const resolve = vi.fn(async () => ({}));
    for (let i = 0; i < MAX_KNOWN; i++)
      await isRenderableLocation(`p-${i}`, resolve, { now: 5 });
    // p-0 expires; refreshing it must not push out p-1.
    await isRenderableLocation("p-0", resolve, { now: 5 + KNOWN_TTL_MS + 1 });
    resolve.mockClear();
    await isRenderableLocation("p-1", resolve, { now: 5 });
    expect(resolve).not.toHaveBeenCalled();
  });
});


describe("bare seed names redirect to the canonical seed slug (#302)", () => {
  it.each([
    ["/phuket", "/phuket-th"],
    ["/Phuket", "/phuket-th"],
    ["/phuket/forecast", "/phuket-th/forecast"],
    ["/Phuket/Map", "/phuket-th/map"],
    ["/nairobi", "/nairobi-ke"],
    ["/bangkok", "/bangkok-th"],
  ])("%s redirects to %s", (path, location) => {
    expect(classifyLocationPath(path, KNOWN)).toEqual({
      kind: "redirect",
      location,
    });
  });

  it("never shadows a seed slug or a known route", () => {
    expect(classifyLocationPath("/harare", KNOWN)).toEqual({
      kind: "slug",
      slug: "harare",
    });
    const seedSlugs = new Set(LOCATIONS.map((l) => l.slug));
    for (const [alias, target] of SEED_NAME_ALIASES) {
      expect(seedSlugs.has(alias)).toBe(false);
      expect(seedSlugs.has(target)).toBe(true);
      expect(KNOWN.has(alias)).toBe(false);
    }
    const withRoute = new Set([...KNOWN, "phuket"]);
    expect(classifyLocationPath("/phuket", withRoute)).toEqual({
      kind: "other",
    });
  });

  it("only aliases a name exactly one seed carries", () => {
    const counts = new Map<string, number>();
    for (const l of LOCATIONS) {
      const k = slugifyName(l.name);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const alias of SEED_NAME_ALIASES.keys()) {
      expect(counts.get(alias)).toBe(1);
    }
    const shared = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
    for (const name of shared) expect(SEED_NAME_ALIASES.has(name)).toBe(false);
  });

  it("aliases only redirect seeds whose slug differs from the bare name", () => {
    for (const [alias, target] of SEED_NAME_ALIASES) {
      expect(target).not.toBe(alias);
      expect(target.includes("--")).toBe(false);
    }
    expect(SEED_NAME_ALIASES.size).toBeGreaterThan(100);
  });
});
