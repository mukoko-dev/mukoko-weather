/**
 * The full-screen map, rendered (#542): what a visitor gets when the Tomorrow.io
 * layers are at capacity. Unlike the source-reading tests in MapDashboard.test.ts,
 * these RENDER the real dashboard (server render for the first paint; the real
 * React DOM, src/lib/test-render.ts, for effects, state and taps) with the map
 * itself replaced by a stand-in that records what it is told to draw, the tiles
 * host faked, and nothing sent anywhere: `fetch` is a stub.
 *
 * What is NOT here: layout, CSS and a real MapLibre. Those are in the
 * real-browser check (the PR says what was run).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPACITY_RECHECK_FLOOR_MS,
  createCapacityProbe,
  type CapacityProbe,
} from "@/lib/map-capacity";
import { BLANK, REAL } from "@/lib/map-capacity-fixtures";
import { MAP_LAYER_STORAGE_KEY } from "@/lib/map-layers";
import type { WeatherLocation } from "@/lib/locations";
import { act, mount } from "@/lib/test-render";

const session = vi.hoisted(() => ({
  probe: undefined as unknown as CapacityProbe,
  /** What the map stand-in was last told to draw. */
  drawn: [] as { weatherLayer: string | null }[],
}));

// The session's probe, replaced per test so no verdict leaks between tests.
vi.mock("@/lib/map-capacity", async (original) => {
  const actual = await original<typeof import("@/lib/map-capacity")>();
  return {
    ...actual,
    get layerCapacity() {
      return session.probe;
    },
  };
});
// The map itself: records `weatherLayer`, draws nothing.
vi.mock("next/dynamic", () => ({
  default: () =>
    function MapStandIn(props: { weatherLayer?: string | null }) {
      session.drawn.push({ weatherLayer: props.weatherLayer ?? null });
      return null;
    },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

const harare: WeatherLocation = {
  slug: "harare",
  name: "Harare",
  province: "Harare",
  lat: -17.8292,
  lon: 31.0522,
  elevation: 1490,
  tags: ["city"],
  country: "ZW",
};

const { MapDashboard } = await import("./MapDashboard");

/** A localStorage that remembers what it is given. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => void items.set(k, v)),
    removeItem: (k: string) => void items.delete(k),
  };
}

/**
 * Every network call the dashboard makes goes here. The tiles host is faked:
 * `tiles` is what it answers; anything else (NASA's time list, the API) is a
 * refusal the dashboard already handles.
 */
function fakeNetwork() {
  let tiles: () => ReturnType<typeof BLANK> = BLANK;
  const tileRequests: string[] = [];
  const fetchStub = vi.fn(async (url: string) => {
    if (url.startsWith("https://weather-tiles.mukoko.com/")) {
      tileRequests.push(url);
      return tiles();
    }
    return { ok: false, status: 503 };
  });
  vi.stubGlobal("fetch", fetchStub);
  return {
    tileRequests,
    answerWith: (next: typeof tiles) => (tiles = next),
  };
}

const text = (m: Awaited<ReturnType<typeof mount>>) =>
  m.container.textContent.replace(/\s+/g, " ");
const legendTitle = (m: Awaited<ReturnType<typeof mount>>) =>
  m.find({ id: "map-legend-title" })[0]?.textContent.trim();
const pressedChips = (m: Awaited<ReturnType<typeof mount>>) =>
  m.find({ "aria-pressed": "true" }).map((n) => n.textContent.trim());
const note = (m: Awaited<ReturnType<typeof mount>>) =>
  m.find({ "data-slot": "layer-capacity-note" })[0];
const lastDrawn = () => session.drawn.at(-1)?.weatherLayer;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
  session.drawn.length = 0;
  session.probe = createCapacityProbe();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MapDashboard: a new visitor", () => {
  it("is first painted on satellite: a working layer, with nothing asked of the tiles host", () => {
    const network = fakeNetwork();
    const html = renderToStaticMarkup(
      createElement(MapDashboard, { location: harare }),
    );
    expect(html).toMatch(/id="map-legend-title"[^>]*>\s*Satellite/);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[^]*?Satellite/);
    expect(html).not.toContain("layer-capacity-note");
    expect(network.tileRequests).toEqual([]);
  });

  it("opens on satellite on the client too, draws it, and never asks the tiles host", async () => {
    const network = fakeNetwork();
    const m = await mount(createElement(MapDashboard, { location: harare }), {
      localStorage: memoryStorage(),
    });
    expect(legendTitle(m)).toMatch(/^Satellite/);
    expect(pressedChips(m)).toEqual(["Satellite"]);
    expect(lastDrawn()).toBe("satellite");
    expect(note(m)).toBeUndefined();
    expect(network.tileRequests).toEqual([]);
    await m.unmount();
  });
});

describe("MapDashboard: Rain chosen, the tiles host sends its blank tile", () => {
  async function openOnRain(strict = false) {
    const network = fakeNetwork();
    const storage = memoryStorage({
      [MAP_LAYER_STORAGE_KEY]: "precipitationIntensity",
    });
    const m = await mount(createElement(MapDashboard, { location: harare }), {
      localStorage: storage,
      strict,
    });
    await act(async () => {});
    return { m, network, storage };
  }

  it("holds the overlay back while the one tile is out, says it is checking, then shows satellite and the note", async () => {
    const network = fakeNetwork();
    let release: (r: ReturnType<typeof BLANK>) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.startsWith("https://weather-tiles.mukoko.com/")) {
          network.tileRequests.push(url);
          return new Promise((resolve) => (release = resolve));
        }
        return Promise.resolve({ ok: false, status: 503 });
      }),
    );
    const m = await mount(createElement(MapDashboard, { location: harare }), {
      localStorage: memoryStorage({
        [MAP_LAYER_STORAGE_KEY]: "precipitationIntensity",
      }),
    });
    // The tile is out: nothing is drawn yet, and the sheet says why.
    expect(lastDrawn()).toBeNull();
    expect(text(m)).toContain("Checking live rain radar…");
    expect(network.tileRequests).toHaveLength(1);
    await act(async () => release(BLANK()));
    expect(lastDrawn()).toBe("satellite");
    expect(text(m)).not.toContain("Checking live rain radar");
    expect(text(m)).toContain(
      "Live rain radar is busy right now. Showing satellite instead.",
    );
    await m.unmount();
  });

  it("shows satellite on screen and in the legend, with its chip pressed, and keeps the choice stored", async () => {
    const { m, network, storage } = await openOnRain();
    expect(legendTitle(m)).toMatch(/^Satellite/);
    expect(pressedChips(m)).toEqual(["Satellite"]);
    expect(lastDrawn()).toBe("satellite");
    expect(note(m)).toBeDefined();
    expect(network.tileRequests).toHaveLength(1);
    // Nothing has been written over the person's choice.
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.items.get(MAP_LAYER_STORAGE_KEY)).toBe(
      "precipitationIntensity",
    );
    await m.unmount();
  });

  it("sends ONE request in StrictMode", async () => {
    const { m, network } = await openOnRain(true);
    expect(network.tileRequests).toHaveLength(1);
    await m.unmount();
  });

  it("lets the person choose Satellite: the choice is stored, the note goes, nothing more is asked", async () => {
    const { m, network, storage } = await openOnRain();
    await m.click(m.button("Satellite")!);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      MAP_LAYER_STORAGE_KEY,
      "satellite",
    );
    expect(note(m)).toBeUndefined();
    expect(lastDrawn()).toBe("satellite");
    expect(network.tileRequests).toHaveLength(1);
    await m.unmount();
  });

  it("switching between the four live chips sends nothing more and never draws a blank layer", async () => {
    const { m, network } = await openOnRain();
    const drawnBefore = session.drawn.length;
    for (const label of ["Temperature", "Wind", "Cloud", "Rain", "Wind"]) {
      await m.click(m.button(label)!);
      expect(pressedChips(m)).toEqual(["Satellite"]);
      expect(note(m)).toBeDefined();
    }
    expect(network.tileRequests).toHaveLength(1);
    // Every frame since the first answer drew the working layer, never a Tomorrow.io one.
    expect(
      session.drawn.slice(drawnBefore).map((d) => d.weatherLayer),
    ).not.toContain("windSpeed");
    expect(
      new Set(session.drawn.slice(drawnBefore).map((d) => d.weatherLayer)),
    ).toEqual(new Set(["satellite"]));
    await m.unmount();
  });

  it("'Try again' inside the floor sends nothing and says it just checked, then goes back to 'Try again'", async () => {
    const { m, network } = await openOnRain();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await m.click(m.button("Try again")!);
    expect(network.tileRequests).toHaveLength(1);
    expect(m.button("Checked a moment ago")).toBeDefined();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS);
    });
    expect(m.button("Try again")).toBeDefined();
    await m.unmount();
  });

  it("'Try again' after the floor asks once, and when the tile is real the layer returns without a reload", async () => {
    const { m, network } = await openOnRain();
    network.answerWith(REAL);
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS);
    });
    await m.click(m.button("Try again")!);
    expect(network.tileRequests).toHaveLength(2);
    expect(note(m)).toBeUndefined();
    expect(legendTitle(m)).toMatch(/^Rain/);
    expect(pressedChips(m)).toEqual(["Rain"]);
    expect(lastDrawn()).toBe("precipitationIntensity");
    await m.unmount();
  });

  it("tapping the busy Rain chip looks again instead of switching", async () => {
    const { m, network, storage } = await openOnRain();
    await act(async () => {
      vi.advanceTimersByTime(CAPACITY_RECHECK_FLOOR_MS);
    });
    await m.click(m.button("Rain")!);
    expect(network.tileRequests).toHaveLength(2);
    expect(storage.setItem).not.toHaveBeenCalled();
    await m.unmount();
  });

  it("says what happened to a screen reader, through the page's live region", async () => {
    const { m } = await openOnRain();
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    const region = m.doc.getElementById("nyuchi-live-region");
    expect(region?.textContent).toBe(
      "Live rain radar is busy right now. Showing satellite instead.",
    );
    await m.unmount();
  });
});

describe("MapDashboard: Rain chosen, the tiles host is working", () => {
  it("draws Rain after the one tile came back, with no note", async () => {
    const network = fakeNetwork();
    network.answerWith(REAL);
    const m = await mount(createElement(MapDashboard, { location: harare }), {
      localStorage: memoryStorage({
        [MAP_LAYER_STORAGE_KEY]: "precipitationIntensity",
      }),
    });
    await act(async () => {});
    expect(lastDrawn()).toBe("precipitationIntensity");
    expect(legendTitle(m)).toMatch(/^Rain/);
    expect(note(m)).toBeUndefined();
    expect(network.tileRequests).toHaveLength(1);
    await m.unmount();
  });
});
