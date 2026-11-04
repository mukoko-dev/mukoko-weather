import { describe, it, expect, vi } from "vitest";
import {
  createWorkerData,
  isDegradedBody,
  workerDataKey,
  WORKER_DATA_FAILURE_TTL_MS,
  WORKER_DATA_MAX_ENTRIES,
  WORKER_DATA_RATE_LIMITED_TTL_MS,
  WORKER_DATA_TTL_MS,
} from "./worker-data";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

/** A fake Worker: counts calls, and how many are in flight per URL path+point. */
function fake(
  answer: (url: URL, n: number) => Response | Promise<Response> = () =>
    json({ ok: true }),
) {
  const urls: URL[] = [];
  let live = 0;
  const liveByKey = new Map<string, number>();
  let maxLiveByKey = 0;
  let maxLive = 0;
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const k = `${url.pathname}?${url.searchParams.get("lat")},${url.searchParams.get("lon")}`;
    live++;
    maxLive = Math.max(maxLive, live);
    liveByKey.set(k, (liveByKey.get(k) ?? 0) + 1);
    maxLiveByKey = Math.max(maxLiveByKey, liveByKey.get(k) ?? 0);
    try {
      // Yield so concurrent callers genuinely overlap.
      await new Promise((r) => setTimeout(r, 5));
      return await answer(url, urls.length);
    } finally {
      live--;
      liveByKey.set(k, (liveByKey.get(k) ?? 1) - 1);
    }
  }) as unknown as typeof fetch;
  return {
    fetcher,
    urls,
    get maxLiveByKey() {
      return maxLiveByKey;
    },
    get maxLive() {
      return maxLive;
    },
  };
}

function store(f = fake(), clock = { t: 1_000_000 }) {
  return {
    f,
    clock,
    s: createWorkerData({ fetcher: f.fetcher, now: () => clock.t }),
  };
}

describe("workerDataKey", () => {
  it("keys a point by the 0.05 degree cell, and sends the 3-decimal rounding", () => {
    const a = workerDataKey("haze", { lat: -17.8291, lon: 31.0534 });
    const b = workerDataKey("haze", { lat: -17.8302, lon: 31.0561 });
    const far = workerDataKey("haze", { lat: -17.9, lon: 31.0534 });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(far.key);
    expect(a.search).toBe("lat=-17.829&lon=31.053");
    expect(a.key).toContain("haze|cell:");
  });

  it("sends and keys the exact coordinate when asked (the GPS fix for /v1/geo)", () => {
    const a = workerDataKey("geo", { lat: -17.82912, lon: 31.05341 }, true);
    const b = workerDataKey("geo", { lat: -17.82913, lon: 31.05341 }, true);
    expect(a.search).toBe("lat=-17.82912&lon=31.05341");
    expect(a.key).not.toBe(b.key);
  });

  it("other parameters are part of the key, in a fixed order, and empty ones are dropped", () => {
    const a = workerDataKey("normals", {
      lat: 1,
      lon: 2,
      date: "2026-11-02",
      x: undefined,
    });
    const b = workerDataKey("normals", { date: "2026-11-02", lon: 2, lat: 1 });
    const other = workerDataKey("normals", {
      lat: 1,
      lon: 2,
      date: "2026-11-03",
    });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(other.key);
    expect(a.search).toBe("lat=1&lon=2&date=2026-11-02");
  });

  it("a route with no point (enso) is keyed by route alone", () => {
    expect(workerDataKey("enso", {}).key).toBe("enso|-|");
  });
});

describe("shared Worker reads", () => {
  it("callers of one route+cell share a single request", async () => {
    const { s, f } = store();
    const [a, b, c] = await Promise.all([
      s.json("haze", { lat: -17.8291, lon: 31.0534 }),
      s.json("haze", { lat: -17.8301, lon: 31.0541 }), // same 0.05 cell
      s.json("haze", { lat: -17.8291, lon: 31.0534 }),
    ]);
    expect(f.urls).toHaveLength(1);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(c).toEqual({ ok: true });
  });

  it("a different cell or route is a separate request", async () => {
    const { s, f } = store();
    await s.json("haze", { lat: -17.83, lon: 31.05 });
    await s.json("haze", { lat: -1.29, lon: 36.82 });
    await s.json("air-quality", { lat: -17.83, lon: 31.05 });
    expect(f.urls.map((u) => u.pathname)).toEqual([
      "/v1/haze",
      "/v1/haze",
      "/v1/air-quality",
    ]);
  });

  it("a kept answer costs nothing, and is read again after its keep time", async () => {
    const { s, f, clock } = store();
    const q = { lat: -17.83, lon: 31.05 };
    await s.json("haze", q);
    await s.json("haze", q); // a remount
    await s.json("haze", q); // a swipe back
    expect(f.urls).toHaveLength(1);

    clock.t += WORKER_DATA_TTL_MS.haze - 1;
    await s.json("haze", q);
    expect(f.urls).toHaveLength(1);

    clock.t += 2; // past the keep time: the data refreshes on its normal cadence
    await s.json("haze", q);
    expect(f.urls).toHaveLength(2);
  });

  it("conditions refresh within minutes; climate normals are kept longer", () => {
    expect(WORKER_DATA_TTL_MS.weather).toBeLessThanOrEqual(10 * 60_000);
    expect(WORKER_DATA_TTL_MS["air-quality"]).toBeLessThanOrEqual(15 * 60_000);
    expect(WORKER_DATA_TTL_MS.haze).toBeLessThanOrEqual(15 * 60_000);
    expect(WORKER_DATA_TTL_MS["aviation/nearest-metar"]).toBeLessThanOrEqual(
      10 * 60_000,
    );
    // Nothing is kept forever.
    for (const ttl of Object.values(WORKER_DATA_TTL_MS)) {
      expect(ttl).toBeLessThanOrEqual(6 * 60 * 60_000);
    }
  });

  it("an unmount stops the caller waiting but never cancels the shared request", async () => {
    const { s, f } = store();
    const q = { lat: -17.83, lon: 31.05 };
    const gone = new AbortController();
    const first = s.json("air-quality", q, { signal: gone.signal });
    gone.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    // The remount asks again at once: it joins the request that is already
    // out (or the answer it brought back) instead of starting another.
    const second = await s.json("air-quality", q);
    expect(second).toEqual({ ok: true });
    expect(f.urls).toHaveLength(1);
  });

  it("an already-aborted signal rejects without starting anything new", async () => {
    const { s, f } = store();
    const c = new AbortController();
    c.abort();
    await expect(
      s.json("haze", { lat: 1, lon: 1 }, { signal: c.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    // The request may have been started for the next caller, but only once.
    expect(f.urls.length).toBeLessThanOrEqual(1);
  });

  it("never has more than one request in flight per route+cell, however many callers", async () => {
    const f = fake();
    const { s } = store(f);
    const callers: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      callers.push(s.json("normals", { lat: -17.83, lon: 31.05, date: "d" }));
      callers.push(s.json("haze", { lat: -17.83, lon: 31.05 }));
      callers.push(s.json("air-quality/grid", { lat: -17.83, lon: 31.05 }));
    }
    await Promise.all(callers);
    expect(f.urls).toHaveLength(3);
    expect(f.maxLiveByKey).toBe(1);
  });

  it("a failure is replayed briefly instead of being asked again on every remount, then retried", async () => {
    const f = fake(() => new Response("boom", { status: 503 }));
    const { s, clock } = store(f);
    const q = { lat: -17.83, lon: 31.05 };
    for (let i = 0; i < 10; i++) {
      await expect(s.json("haze", q)).rejects.toThrow("HTTP 503");
    }
    expect(s.stats().requests).toBe(1);

    clock.t += WORKER_DATA_FAILURE_TTL_MS + 1;
    await expect(s.json("haze", q)).rejects.toThrow("HTTP 503");
    expect(s.stats().requests).toBe(2);
  });

  it("a 429 is left alone for longer", async () => {
    const f = fake(() => new Response("slow down", { status: 429 }));
    const { s, clock } = store(f);
    const q = { lat: -17.83, lon: 31.05 };
    await expect(s.json("haze", q)).rejects.toThrow("HTTP 429");
    clock.t += WORKER_DATA_FAILURE_TTL_MS + 1;
    await expect(s.json("haze", q)).rejects.toThrow("HTTP 429");
    expect(f.urls).toHaveLength(1);
    clock.t += WORKER_DATA_RATE_LIMITED_TTL_MS;
    await expect(s.json("haze", q)).rejects.toThrow("HTTP 429");
    expect(f.urls).toHaveLength(2);
  });

  it("a network error rejects every waiting caller and is remembered briefly", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const s = createWorkerData({ fetcher: f });
    const q = { lat: 1, lon: 1 };
    const results = await Promise.allSettled([
      s.json("haze", q),
      s.json("haze", q),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    await expect(s.json("haze", q)).rejects.toThrow();
    expect(s.stats().requests).toBe(1);
  });

  it("a 200 whose body is not JSON is a failure, not a kept answer", async () => {
    const f = fake(() => new Response("<html>", { status: 200 }));
    const { s } = store(f);
    await expect(s.json("haze", { lat: 1, lon: 1 })).rejects.toThrow(
      "HTTP 502",
    );
  });

  it("read() surfaces the provider header and the status without throwing", async () => {
    const f = fake(() =>
      json({ a: 1 }, { headers: { "X-Weather-Provider": "open-meteo:blend" } }),
    );
    const { s } = store(f);
    const res = await s.read("weather", { lat: 1, lon: 1 });
    expect(res).toMatchObject({
      ok: true,
      status: 200,
      provider: "open-meteo:blend",
      data: { a: 1 },
    });
    const missing = createWorkerData({
      fetcher: (async () =>
        new Response("no", { status: 404 })) as typeof fetch,
    });
    const nf = await missing.read("geo", { lat: 1, lon: 1 }, { exact: true });
    expect(nf).toMatchObject({ ok: false, status: 404, data: null });
  });

  it("sends the rounded coordinate, JSON accept header, and the other parameters", async () => {
    const { s, f } = store();
    await s.json("normals", {
      lat: -17.82917,
      lon: 31.05341,
      date: "2026-11-02",
    });
    expect(f.urls[0].pathname).toBe("/v1/normals");
    expect(f.urls[0].searchParams.get("lat")).toBe("-17.829");
    expect(f.urls[0].searchParams.get("lon")).toBe("31.053");
    expect(f.urls[0].searchParams.get("date")).toBe("2026-11-02");
  });

  it("peek returns a kept good answer and starts nothing", async () => {
    const { s, f } = store();
    const q = { lat: -17.83, lon: 31.05 };
    expect(s.peek("haze", q)).toBeUndefined();
    await s.json("haze", q);
    expect(s.peek("haze", q)?.data).toEqual({ ok: true });
    expect(f.urls).toHaveLength(1);
  });

  it("invalidate and force read again", async () => {
    const { s, f } = store();
    const q = { lat: -17.83, lon: 31.05 };
    await s.json("reports", { ...q, location: "harare" });
    s.invalidate("reports", { ...q, location: "harare" });
    await s.json("reports", { ...q, location: "harare" });
    await s.json("reports", { ...q, location: "harare" }, { force: true });
    expect(f.urls).toHaveLength(3);
  });

  it("holds a bounded number of entries", async () => {
    const f = fake();
    const s = createWorkerData({ fetcher: f.fetcher, maxEntries: 5 });
    for (let i = 0; i < 20; i++) {
      await s.json("haze", { lat: i * 0.5, lon: i * 0.5 });
    }
    expect(s.stats().entries).toBeLessThanOrEqual(5);
    expect(WORKER_DATA_MAX_ENTRIES).toBeGreaterThan(20);
  });

  it("retries one call once on a 5xx or network error (as the Worker client does), never on a 4xx, and not at all when told", async () => {
    const f = fake(() => new Response("x", { status: 503 }));
    const { s } = store(f);
    await expect(s.json("haze", { lat: 1, lon: 1 })).rejects.toThrow();
    expect(f.urls).toHaveLength(2); // one request, one retry

    const g = fake(() => new Response("x", { status: 503 }));
    const { s: s2 } = store(g);
    await expect(
      s2.json("haze", { lat: 1, lon: 1 }, { retries: 0 }),
    ).rejects.toThrow();
    expect(g.urls).toHaveLength(1);

    const h = fake(() => new Response("x", { status: 404 }));
    const { s: s3 } = store(h);
    await expect(s3.json("haze", { lat: 1, lon: 1 })).rejects.toThrow();
    expect(h.urls).toHaveLength(1);
  });

  it("settled answers are readable and announced: subscribe fires on settle, invalidate and reset", async () => {
    const { s } = store();
    const seen = vi.fn();
    const off = s.subscribe(seen);
    const q = { lat: -17.83, lon: 31.05 };
    expect(s.peekSettled("haze", q)).toBeUndefined();
    await s.json("haze", q);
    expect(seen).toHaveBeenCalledTimes(1);
    const first = s.peekSettled("haze", q);
    expect(first?.ok).toBe(true);
    expect(s.peekSettled("haze", q)).toBe(first); // stable between settles
    s.invalidate("haze", q);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(s.peekSettled("haze", q)).toBeUndefined();
    off();
    s.reset();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("an expired answer stays readable (stale) while it is read again, then is replaced", async () => {
    const { s, clock } = store();
    const q = { lat: -17.83, lon: 31.05 };
    await s.json("haze", q);
    const stale = s.peekSettled("haze", q);
    clock.t += WORKER_DATA_TTL_MS.haze + 1;
    const refresh = s.json("haze", q);
    expect(s.peekSettled("haze", q)).toBe(stale); // not blanked
    await refresh;
    expect(s.peekSettled("haze", q)).not.toBe(stale);
  });

  it("a 200 that says it could not really answer is kept only briefly", async () => {
    for (const body of [
      { available: false, reason: "upstream_error" },
      { status: "unavailable" },
      { degraded: true, data: [] },
      { nearest: { namingSkipped: true } },
    ]) {
      const f = fake(() => json(body));
      const { s, clock } = store(f);
      const q = { lat: 1, lon: 1 };
      await s.json("haze", q);
      await s.json("haze", q);
      expect(s.stats().requests, JSON.stringify(body)).toBe(1);
      clock.t += WORKER_DATA_FAILURE_TTL_MS + 1;
      await s.json("haze", q);
      expect(s.stats().requests, JSON.stringify(body)).toBe(2);
    }
  });

  it("a good answer is not mistaken for a degraded one", () => {
    expect(isDegradedBody({ available: true, status: "ok" })).toBe(false);
    expect(isDegradedBody({ status: "no_recent_report" })).toBe(false);
    expect(isDegradedBody(null)).toBe(false);
    expect(isDegradedBody([1, 2])).toBe(false);
  });

  it("a refresh that fails does not blank the good answer on screen (stale stays), but its callers see the failure", async () => {
    let healthy = true;
    const f = fake(() =>
      healthy ? json({ aqi: 40 }) : new Response("x", { status: 503 }),
    );
    const { s, clock } = store(f);
    const q = { lat: -17.83, lon: 31.05 };
    await s.json("air-quality", q);
    const good = s.peekSettled("air-quality", q);
    expect(good?.ok).toBe(true);

    healthy = false;
    clock.t += WORKER_DATA_TTL_MS["air-quality"] + 1;
    await expect(s.json("air-quality", q, { retries: 0 })).rejects.toThrow(
      "HTTP 503",
    );
    // What a section reads is still the good answer...
    expect(s.peekSettled("air-quality", q)).toBe(good);
    // ...and the failure is not asked again at once.
    await expect(s.json("air-quality", q, { retries: 0 })).rejects.toThrow();
    expect(s.stats().requests).toBe(2);

    // Once the failure has been replayed, the next read can recover it.
    healthy = true;
    clock.t += WORKER_DATA_FAILURE_TTL_MS + 1;
    await s.json("air-quality", q);
    expect(s.peekSettled("air-quality", q)).not.toBe(good);
    expect(s.peekSettled("air-quality", q)?.ok).toBe(true);
  });

  it("a refresh that comes back degraded (available: false) does not replace a good answer either", async () => {
    let degraded = false;
    const f = fake(() =>
      degraded ? json({ available: false }) : json({ available: true, aqi: 1 }),
    );
    const { s, clock } = store(f);
    const q = { lat: 1, lon: 1 };
    await s.json("haze", q);
    const good = s.peekSettled("haze", q);
    degraded = true;
    clock.t += WORKER_DATA_TTL_MS.haze + 1;
    await s.json("haze", q); // the caller gets the degraded answer it asked for
    expect(s.peekSettled("haze", q)).toBe(good);
  });
});
