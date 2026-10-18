import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BASE_MAP_PROVIDERS,
  DAILY_COMPLETE_HOUR_UTC,
  DEFAULT_MAP_MODEL,
  GIBS_LAYERS,
  GIBS_WMTS_ORIGIN,
  MAP_MODELS,
  MAP_PROVIDERS,
  MODEL_LAYER_VARIABLES,
  attributionForLayer,
  attributionHtml,
  buildGibsSource,
  fetchGibsDomains,
  getGibsLayer,
  getMapModel,
  gibsDomainsUrl,
  gibsTileUrl,
  isGibsLayer,
  isModelLayer,
  mapModelForPreference,
  overlayAttribution,
  withoutStyleAttributions,
  parseGibsDomains,
  satelliteFrames,
} from "./map-sources";
import { MAP_CHIPS, MODEL_CHIPS } from "./map-layers";

const viirs = GIBS_LAYERS.satellite;
const imerg = GIBS_LAYERS.satelliteRain;

describe("MAP_PROVIDERS — one source of truth for credits", () => {
  it("gives every provider a label, an https link and a licence", () => {
    for (const p of Object.values(MAP_PROVIDERS)) {
      expect(p.label).toBeTruthy();
      expect(p.href).toMatch(/^https:\/\//);
      expect(p.licence).toBeTruthy();
    }
  });

  it("keys each provider by its own id", () => {
    for (const [key, p] of Object.entries(MAP_PROVIDERS)) {
      expect(p.id).toBe(key);
    }
  });

  it("records the non-commercial free plans as needing a paid plan", () => {
    // MapTiler Free and Open-Meteo's free API are non-commercial (owner decision).
    expect(MAP_PROVIDERS.maptiler.commercialUse).toBe("paid-plan");
    expect(MAP_PROVIDERS["open-meteo"].commercialUse).toBe("paid-plan");
    // Public domain / CC BY 4.0 sources are commercially safe.
    expect(MAP_PROVIDERS["nasa-gibs"].commercialUse).toBe("allowed");
    expect(MAP_PROVIDERS.ecmwf.commercialUse).toBe("allowed");
    expect(MAP_PROVIDERS.noaa.commercialUse).toBe("allowed");
  });

  it("uses the acknowledgement NASA asks GIBS clients for", () => {
    expect(MAP_PROVIDERS["nasa-gibs"].label).toContain("NASA GIBS");
    expect(MAP_PROVIDERS["nasa-gibs"].label).toContain("ESDIS");
  });
});

describe("attributionForLayer", () => {
  it("always credits the base map first", () => {
    const ids = attributionForLayer(null).map((p) => p.id);
    expect(ids).toEqual([...BASE_MAP_PROVIDERS]);
  });

  it("credits every chip's overlay provider", () => {
    for (const chip of [...MAP_CHIPS, ...MODEL_CHIPS]) {
      const credits = attributionForLayer(chip.id);
      expect(credits.length).toBeGreaterThan(BASE_MAP_PROVIDERS.length);
    }
  });

  it("credits Tomorrow.io for its tile layers", () => {
    expect(
      attributionForLayer("precipitationIntensity").map((p) => p.id),
    ).toContain("tomorrow");
  });

  it("credits NASA GIBS and the instrument for satellite layers", () => {
    expect(attributionForLayer("satellite").map((p) => p.id)).toEqual([
      "maptiler",
      "osm",
      "nasa-gibs",
      "nasa-viirs",
    ]);
    expect(attributionForLayer("satelliteRain").map((p) => p.id)).toContain(
      "nasa-imerg",
    );
  });

  it("credits CAMS via Open-Meteo for air quality", () => {
    const ids = attributionForLayer("airQuality").map((p) => p.id);
    expect(ids).toContain("cams");
    expect(ids).toContain("open-meteo");
  });

  it("credits the chosen model's agency plus Open-Meteo for model fields", () => {
    expect(
      attributionForLayer("modelTemperature", "gfs_seamless").map((p) => p.id),
    ).toEqual(["maptiler", "osm", "noaa", "open-meteo"]);
    expect(
      attributionForLayer("modelWind", "icon_global").map((p) => p.id),
    ).toContain("dwd");
    expect(
      attributionForLayer("modelWind", "gem_global").map((p) => p.id),
    ).toContain("eccc");
    expect(
      attributionForLayer("modelWind", "meteofrance_arpege_world").map(
        (p) => p.id,
      ),
    ).toContain("meteo-france");
    // Unknown model → the default (ECMWF IFS).
    expect(attributionForLayer("modelWind", "nope").map((p) => p.id)).toContain(
      "ecmwf",
    );
  });

  it("never lists a provider twice", () => {
    for (const chip of [...MAP_CHIPS, ...MODEL_CHIPS]) {
      const ids = attributionForLayer(chip.id).map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("overlayAttribution drops the base map", () => {
    const ids = overlayAttribution("satellite").map((p) => p.id);
    expect(ids).not.toContain("maptiler");
    expect(ids).toContain("nasa-gibs");
  });
});

describe("attributionHtml", () => {
  it("renders safe links joined by a separator", () => {
    const html = attributionHtml(attributionForLayer("satellite"));
    expect(html).toContain('href="https://www.openstreetmap.org/copyright"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(" · ");
  });

  it("escapes markup in labels", () => {
    const html = attributionHtml([
      { ...MAP_PROVIDERS.osm, label: "<b>x</b> & y" },
    ]);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
    expect(html).not.toContain("<b>");
  });
});

describe("models", () => {
  it("lists the six blend members, ECMWF IFS first", () => {
    expect(MAP_MODELS.map((m) => m.id)).toEqual([
      "ecmwf_ifs",
      "ecmwf_aifs025_single",
      "gfs_seamless",
      "icon_global",
      "gem_global",
      "meteofrance_arpege_world",
    ]);
    expect(DEFAULT_MAP_MODEL).toBe("ecmwf_ifs");
  });

  it("maps each model to a credited agency", () => {
    for (const m of MAP_MODELS) {
      expect(MAP_PROVIDERS[m.provider]).toBeDefined();
    }
  });

  it("opens on the stored preference when it is a blend member", () => {
    expect(mapModelForPreference("gfs_seamless")).toBe("gfs_seamless");
    expect(mapModelForPreference("best_match")).toBe("ecmwf_ifs");
    expect(mapModelForPreference("meteofrance_seamless")).toBe("ecmwf_ifs");
    expect(mapModelForPreference(undefined)).toBe("ecmwf_ifs");
    expect(getMapModel("nope")).toBeUndefined();
  });

  it("knows which chips are model fields", () => {
    expect(Object.keys(MODEL_LAYER_VARIABLES)).toEqual(
      MODEL_CHIPS.map((c) => c.id),
    );
    expect(isModelLayer("modelTemperature")).toBe(true);
    expect(isModelLayer("temperature")).toBe(false);
  });
});

describe("NASA GIBS layers", () => {
  it("has a chip for every GIBS layer", () => {
    for (const layer of Object.values(GIBS_LAYERS)) {
      expect(MAP_CHIPS.some((c) => c.id === layer.chipId)).toBe(true);
      expect(isGibsLayer(layer.chipId)).toBe(true);
      expect(getGibsLayer(layer.chipId)).toBe(layer);
    }
    expect(isGibsLayer("precipitationIntensity")).toBe(false);
  });

  it("pins the native zoom to the tile matrix set level", () => {
    for (const layer of Object.values(GIBS_LAYERS)) {
      expect(layer.matrixSet).toBe(
        `GoogleMapsCompatible_Level${layer.maxZoom}`,
      );
    }
  });

  it("builds the REST tile template GIBS serves (z/y/x order)", () => {
    expect(gibsTileUrl(viirs, "2026-10-10")).toBe(
      `${GIBS_WMTS_ORIGIN}/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-10-10/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
    );
    expect(gibsTileUrl(imerg, "2026-10-11T01:30:00Z")).toContain(
      "/default/2026-10-11T01%3A30%3A00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png",
    );
  });

  it("never puts a key in the URL (GIBS is keyless)", () => {
    expect(gibsTileUrl(viirs, "2026-10-10")).not.toMatch(/key|token/i);
  });

  it("builds a DescribeDomains URL spanning the last ten days", () => {
    const url = gibsDomainsUrl(imerg, new Date("2026-10-11T07:00:00Z"));
    expect(url).toBe(
      `${GIBS_WMTS_ORIGIN}/wmts/epsg3857/best/1.0.0/IMERG_Precipitation_Rate_30min/default/GoogleMapsCompatible_Level6/all/2026-10-01--2026-10-12.xml`,
    );
  });

  it("builds a raster source with zoom range and attribution", () => {
    const src = buildGibsSource(viirs, "2026-10-10");
    expect(src.type).toBe("raster");
    expect(src.maxzoom).toBe(9);
    expect(src.tiles[0]).toContain("2026-10-10");
    expect(src.attribution).toContain("NASA GIBS");
  });
});

describe("parseGibsDomains", () => {
  it("reads a live DescribeDomains response", () => {
    // Shape returned by GIBS on 2026-10-11.
    const xml =
      "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><SpaceDomain/><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-10-10/2026-10-11T01:30:00Z/PT30M</Domain><Size>1</Size></DimensionDomain></Domains>";
    const [iv] = parseGibsDomains(xml);
    expect(new Date(iv.start).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(new Date(iv.end).toISOString()).toBe("2026-10-11T01:30:00.000Z");
    expect(iv.periodMs).toBe(30 * 60_000);
  });

  it("reads several intervals and daily periods", () => {
    const xml =
      "<Domain>2026-10-01/2026-10-05/P1D,2026-10-07/2026-10-11/P1D</Domain>";
    const ivs = parseGibsDomains(xml);
    expect(ivs).toHaveLength(2);
    expect(ivs[1].periodMs).toBe(86_400_000);
  });

  it("skips malformed entries and returns [] for unreadable documents", () => {
    expect(parseGibsDomains("not xml")).toEqual([]);
    expect(
      parseGibsDomains("<Domain>x/y/P1D,2026-10-02/2026-10-01/P1D</Domain>"),
    ).toEqual([]);
    expect(
      parseGibsDomains("<Domain>2026-10-01/2026-10-02/PX</Domain>"),
    ).toEqual([]);
  });
});

describe("satelliteFrames", () => {
  const imergDomain = parseGibsDomains(
    "<Domain>2026-10-10/2026-10-11T01:30:00Z/PT30M</Domain>",
  );

  it("ends the IMERG loop on the newest frame GIBS has, oldest first", () => {
    const frames = satelliteFrames(
      imerg,
      imergDomain,
      new Date("2026-10-11T07:31:00Z"),
    );
    expect(frames).toHaveLength(imerg.frames);
    expect(frames.at(-1)!.time).toBe("2026-10-11T01:30:00Z");
    expect(frames[0].time).toBe("2026-10-10T19:30:00Z");
    expect(frames.at(-1)!.label).toBe("−6h01");
  });

  it("never offers a future frame (GIBS answers those with 404)", () => {
    const now = new Date("2026-10-11T01:10:00Z");
    const frames = satelliteFrames(imerg, imergDomain, now);
    for (const f of frames) {
      expect(Date.parse(f.time)).toBeLessThanOrEqual(now.getTime());
    }
    expect(frames.at(-1)!.time).toBe("2026-10-11T01:00:00Z");
  });

  it("skips today's partial daily mosaic before the cut-off hour", () => {
    const domain = parseGibsDomains(
      "<Domain>2026-10-01/2026-10-11/P1D</Domain>",
    );
    const morning = satelliteFrames(
      viirs,
      domain,
      new Date("2026-10-11T07:00:00Z"),
    );
    expect(morning.at(-1)!.time).toBe("2026-10-10");
    expect(morning.at(-1)!.label).toBe("Yesterday");
    expect(morning).toHaveLength(viirs.frames);
    expect(morning[0].time).toBe("2026-10-04");

    const evening = satelliteFrames(
      viirs,
      domain,
      new Date(
        `2026-10-11T${String(DAILY_COMPLETE_HOUR_UTC).padStart(2, "0")}:05:00Z`,
      ),
    );
    expect(evening.at(-1)!.time).toBe("2026-10-11");
    expect(evening.at(-1)!.label).toBe("Today");
  });

  it("walks across gaps between intervals", () => {
    const domain = parseGibsDomains(
      "<Domain>2026-10-01/2026-10-03/P1D,2026-10-06/2026-10-10/P1D</Domain>",
    );
    const frames = satelliteFrames(
      viirs,
      domain,
      new Date("2026-10-11T07:00:00Z"),
    );
    expect(frames.map((f) => f.time)).toEqual([
      "2026-10-02",
      "2026-10-03",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
    ]);
  });

  it("falls back to a fixed latency when the lookup failed", () => {
    const frames = satelliteFrames(
      imerg,
      null,
      new Date("2026-10-11T07:31:00Z"),
    );
    expect(frames).toHaveLength(imerg.frames);
    // now − 8 h, floored to the half hour.
    expect(frames.at(-1)!.time).toBe("2026-10-10T23:30:00Z");
    const daily = satelliteFrames(viirs, [], new Date("2026-10-11T07:00:00Z"));
    expect(daily.at(-1)!.time).toBe("2026-10-10");
  });
});

describe("fetchGibsDomains", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => "<Domain>2026-10-01/2026-10-10/P1D</Domain>",
      })),
    );
    const out = await fetchGibsDomains(viirs, new Date("2026-10-11T00:00:00Z"));
    expect(out).toHaveLength(1);
  });

  it("returns null on HTTP errors, network errors and empty domains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, text: async () => "" })),
    );
    expect(await fetchGibsDomains(viirs, new Date())).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await fetchGibsDomains(viirs, new Date())).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => "<x/>" })),
    );
    expect(await fetchGibsDomains(viirs, new Date())).toBeNull();
  });
});

describe("withoutStyleAttributions (no duplicate base-map credits)", () => {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  // Strip tags until the string stops changing, so nested fragments such as
  // "<<b>script>" cannot survive a single pass.
  const stripTags = (html: string): string => {
    let prev: string;
    let out = html;
    do {
      prev = out;
      out = out.replace(/<[^>]*>/g, "");
    } while (out !== prev);
    return out;
  };
  // What MapLibre's AttributionControl shows: the custom credits plus every
  // source's own attribution, split into individual credits.
  const rendered = (s: { sources: Record<string, unknown> }, custom: string) =>
    stripTags(
      [
        custom,
        ...Object.values(s.sources).map(
          (x) => (x as { attribution?: string }).attribution ?? "",
        ),
      ].join("|"),
    )
      .replace(/&copy;/g, "©")
      .split(/[|·]|(?=©)/)
      .map(norm)
      .filter(Boolean);
  const style = {
    version: 8,
    sources: {
      openmaptiles: {
        type: "vector",
        url: "https://api.maptiler.com/tiles/v3/tiles.json",
        attribution:
          '<a href="https://www.maptiler.com/copyright/">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap contributors</a>',
      },
      plain: { type: "geojson", data: { type: "FeatureCollection" } },
    },
    layers: [],
  };
  const providers = attributionForLayer("airQuality");
  const custom = attributionHtml(providers);
  const count = (list: string[], needle: string) =>
    list.filter((c) => c.includes(needle)).length;

  it("the raw style plus custom credits duplicates them (the bug)", () => {
    expect(count(rendered(style, custom), "maptiler")).toBe(2);
  });

  it("credits MapTiler and OpenStreetMap contributors exactly once", () => {
    const list = rendered(withoutStyleAttributions(style), custom);
    expect(count(list, "maptiler")).toBe(1);
    expect(count(list, "openstreetmap contributors")).toBe(1);
  });

  it("keeps every overlay credit once and leaves other fields untouched", () => {
    const out = withoutStyleAttributions(style);
    const list = rendered(out, custom);
    for (const p of providers)
      expect(list.filter((c) => c === norm(p.label))).toHaveLength(1);
    expect(out.sources.openmaptiles).toMatchObject({
      type: "vector",
      url: style.sources.openmaptiles.url,
    });
    expect("attribution" in out.sources.openmaptiles).toBe(false);
    expect(out.sources.plain).toBe(style.sources.plain);
    expect(style.sources.openmaptiles.attribution).toContain("MapTiler");
  });
});
