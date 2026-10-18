import { readdirSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BARE_BACKOFF_MS,
  BARE_HIT_TTL_MS,
  BARE_MISS_TTL_MS,
  BARE_PER_VISITOR,
  bareNameQuery,
  isBareNameCandidate,
  resetBareNameCache,
  resolveBareName,
} from "./bare-name";
import { buildSmartSlug } from "./smart-slug";

const SAMUI = buildSmartSlug("Ko Samui", 9.51201, 100.01361);
const ENV = { NEXT_PUBLIC_WEATHER_API_URL: "https://weather-api.test" };

function reply(body: unknown, status = 200) {
  return vi.fn(async () =>
    Response.json(body, { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const ok = (slug = SAMUI) => reply({ locations: [{ slug }], resolve: "ok" });
const none = () => reply({ locations: [], resolve: "no_match" });

beforeEach(() => resetBareNameCache());

describe("isBareNameCandidate", () => {
  it.each([
    "koh-samui",
    "chiang-rai",
    "lake-kariba",
    "thailand",
    "6th-of-october-city",
  ])("accepts %s", (slug) => expect(isBareNameCandidate(slug)).toBe(true));

  it.each([
    "ab",
    "x".repeat(61),
    "12345",
    "1-2-3",
    "Koh-Samui",
    "koh--samui",
    "koh_samui",
    "koh samui",
    "-koh",
    "ko-samui--ksy4dd7",
    "admin",
    "wp-login",
    "wp-admin",
    "cgi-bin",
    "pricing",
  ])("rejects %s", (slug) => expect(isBareNameCandidate(slug)).toBe(false));

  it.each([
    "settings",
    "contact",
    "home",
    "blog",
    "news",
    "docs",
    "weather",
    "forecast",
    "search",
    "map",
    "app",
    "user",
    "shop",
    "feed",
    "rss",
    "login",
    "signin",
    "signup",
    "logout",
    "about",
  ])("never geocodes the site word %s", (word) => {
    expect(isBareNameCandidate(word)).toBe(false);
  });

  it("covers every real top-level route directory under src/app", () => {
    const appDir = resolve(__dirname, "../app");
    const routes = readdirSync(appDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => !/^[[(_@]/.test(n));
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      expect(isBareNameCandidate(route), route).toBe(false);
    }
  });

  it("spaces the name for the geocoder", () => {
    expect(bareNameQuery("koh-samui")).toBe("koh samui");
  });
});

describe("resolveBareName", () => {
  it("returns the canonical spot slug and asks the Rust Worker", async () => {
    const fetcher = ok();
    expect(await resolveBareName("koh-samui", { fetcher, env: ENV })).toBe(
      SAMUI,
    );
    const [url, init] = vi.mocked(fetcher).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://weather-api.test/v1/search?mode=resolve&q=koh%20samui",
    );
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
  });

  it("asks the production Worker by default, and never a plaintext override", async () => {
    for (const env of [
      {},
      { NEXT_PUBLIC_WEATHER_API_URL: "http://evil.test" },
    ]) {
      const fetcher = ok();
      await resolveBareName("koh-samui", { fetcher, env });
      expect(String(fetcher.mock.calls[0][0])).toContain(
        "https://weather-api.mukoko.com/v1/search?mode=resolve",
      );
      resetBareNameCache();
    }
  });

  it("accepts a shipped seed slug as the target", async () => {
    expect(
      await resolveBareName("phuket-town", {
        fetcher: ok("phuket-th"),
        env: ENV,
      }),
    ).toBe("phuket-th");
  });

  it.each(["community-record-a1b2c3", "evil//host", "koh-samui", ""])(
    "refuses the target %j",
    async (slug) => {
      expect(
        await resolveBareName("koh-samui", { fetcher: ok(slug), env: ENV }),
      ).toBeNull();
    },
  );

  it("never calls upstream for a non-candidate", async () => {
    const fetcher = ok();
    expect(await resolveBareName("admin", { fetcher, env: ENV })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("caches a hit for hours", async () => {
    const fetcher = ok();
    await resolveBareName("koh-samui", { fetcher, env: ENV, now: 0 });
    expect(
      await resolveBareName("koh-samui", {
        fetcher,
        env: ENV,
        now: BARE_HIT_TTL_MS - 1,
      }),
    ).toBe(SAMUI);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await resolveBareName("koh-samui", {
      fetcher,
      env: ENV,
      now: BARE_HIT_TTL_MS + 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caches a miss briefly (negative cache)", async () => {
    const fetcher = none();
    expect(
      await resolveBareName("zzzz-town", { fetcher, env: ENV, now: 0 }),
    ).toBeNull();
    await resolveBareName("zzzz-town", {
      fetcher,
      env: ENV,
      now: BARE_MISS_TTL_MS - 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await resolveBareName("zzzz-town", {
      fetcher,
      env: ENV,
      now: BARE_MISS_TTL_MS + 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(BARE_MISS_TTL_MS).toBeLessThan(BARE_HIT_TTL_MS);
  });

  it.each(["over_budget", "unavailable"])(
    "treats %s as not found, never caches it, and backs off",
    async (state) => {
      const fetcher = reply({ locations: [], resolve: state });
      expect(
        await resolveBareName("koh-samui", { fetcher, env: ENV, now: 0 }),
      ).toBeNull();
      // Backed off: no upstream call for ANY name until the window ends.
      await resolveBareName("chiang-rai", {
        fetcher,
        env: ENV,
        now: BARE_BACKOFF_MS - 1,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      // After the backoff the same name is asked again (it was not cached).
      await resolveBareName("koh-samui", {
        fetcher,
        env: ENV,
        now: BARE_BACKOFF_MS + 1,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("treats an HTTP error or a network failure as not found and backs off", async () => {
    const bad = reply({}, 503);
    expect(
      await resolveBareName("koh-samui", { fetcher: bad, env: ENV, now: 0 }),
    ).toBeNull();
    const thrown = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(
      await resolveBareName("chiang-rai", {
        fetcher: thrown,
        env: ENV,
        now: BARE_BACKOFF_MS + 1,
      }),
    ).toBeNull();
    expect(thrown).toHaveBeenCalledTimes(1);
  });

  it("shares one lookup between concurrent requests for a slug", async () => {
    const fetcher = ok();
    const [a, b] = await Promise.all([
      resolveBareName("koh-samui", { fetcher, env: ENV, visitor: "a" }),
      resolveBareName("koh-samui", { fetcher, env: ENV, visitor: "b" }),
    ]);
    expect([a, b]).toEqual([SAMUI, SAMUI]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caps uncached lookups per visitor", async () => {
    const fetcher = none();
    for (let i = 0; i < BARE_PER_VISITOR + 3; i++) {
      await resolveBareName(`nowhere-${i}-town`, {
        fetcher,
        env: ENV,
        visitor: "1.2.3.4",
        now: 0,
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(BARE_PER_VISITOR);
    // Another visitor is unaffected; the window resets for the first.
    await resolveBareName("elsewhere-town", {
      fetcher,
      env: ENV,
      visitor: "5.6.7.8",
      now: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(BARE_PER_VISITOR + 1);
    await resolveBareName("later-town", {
      fetcher,
      env: ENV,
      visitor: "1.2.3.4",
      now: 61_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(BARE_PER_VISITOR + 2);
  });

  it("gives up after the timeout, keeps the lookup alive and caches its answer", async () => {
    let release: (r: Response) => void = () => {};
    const fetcher = vi.fn(
      () => new Promise<Response>((r) => (release = r)),
    ) as unknown as typeof fetch;
    const keepAlive = vi.fn();
    expect(
      await resolveBareName("koh-samui", {
        fetcher,
        env: ENV,
        timeoutMs: 5,
        keepAlive,
      }),
    ).toBeNull();
    expect(keepAlive).toHaveBeenCalledTimes(1);
    release(Response.json({ locations: [{ slug: SAMUI }], resolve: "ok" }));
    await keepAlive.mock.calls[0][0];
    expect(await resolveBareName("koh-samui", { fetcher, env: ENV })).toBe(
      SAMUI,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("writes nothing and never forwards the visitor's address upstream", async () => {
    const fetcher = ok();
    await resolveBareName("koh-samui", {
      fetcher,
      env: ENV,
      visitor: "203.0.113.9",
    });
    const [url, init] = vi.mocked(fetcher).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).not.toContain("203.0.113.9");
    expect(JSON.stringify(init.headers ?? {})).not.toContain("203.0.113.9");
    expect(init.method ?? "GET").toBe("GET");
  });
});
