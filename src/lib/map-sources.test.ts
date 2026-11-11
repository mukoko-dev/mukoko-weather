import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BASE_MAP_PROVIDERS,
  DAILY_COMPLETE_HOUR_UTC,
  DEFAULT_MAP_MODEL,
  GIBS_LAYERS,
  GIBS_WMS_TILE_SIZE,
  GIBS_WMTS_ORIGIN,
  MAP_MAX_ZOOM_DEFAULT,
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
  maxMapZoomFor,
  overlayAttribution,
  planZoomCap,
  withoutStyleAttributions,
  parseGibsDomains,
  satelliteFrames,
  utcDayLabel,
} from "./map-sources";
import { parseSmoothTileUrl } from "./smooth-tile";
import { MAP_CHIPS, MODEL_CHIPS } from "./map-layers";

const viirs = GIBS_LAYERS.satellite;
const imerg = GIBS_LAYERS.satelliteRain;
const fire = GIBS_LAYERS.wildfire;

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

  it("pins the native zoom of a WMTS layer to the tile matrix set level", () => {
    for (const layer of Object.values(GIBS_LAYERS)) {
      if (layer.service !== "wmts") continue;
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

describe("GIBS zoom caps (the data is magnified past its native zoom)", () => {
  /**
   * WMTS tiles are 256 px, so tile zoom z is native at MapLibre map zoom z - 1.
   * A WMS layer is drawn for 512 px tiles on request, so its zoom is the map's.
   */
  const nativeMapZoom = (layer: typeof imerg) =>
    layer.service === "wms" ? layer.maxZoom : layer.maxZoom - 1;

  it("caps IMERG rain at map zoom 8 and VIIRS true colour at 9", () => {
    expect(imerg.maxMapZoom).toBe(8);
    expect(viirs.maxMapZoom).toBe(9);
    expect(maxMapZoomFor("satelliteRain", MAP_MAX_ZOOM_DEFAULT)).toBe(8);
    expect(maxMapZoomFor("satellite", MAP_MAX_ZOOM_DEFAULT)).toBe(9);
  });

  it("never caps below the data's native zoom, so the cap hides nothing real", () => {
    for (const layer of Object.values(GIBS_LAYERS)) {
      expect(layer.maxMapZoom).toBeGreaterThanOrEqual(nativeMapZoom(layer));
    }
  });

  it("keeps one IMERG data cell (0.1 degree, 4.5 px in a tile) readable at the cap", () => {
    // 4.5 px per cell at native zoom, doubled for every map zoom above it.
    const cellPx = 4.5 * 2 ** (imerg.maxMapZoom - nativeMapZoom(imerg));
    expect(cellPx).toBe(36);
    // The uncapped view of the owner's screenshot, zoom 10, was 144 px: a soft block.
    expect(4.5 * 2 ** (10 - nativeMapZoom(imerg))).toBe(144);
    // VIIRS is at most 2x magnified.
    expect(2 ** (viirs.maxMapZoom - nativeMapZoom(viirs))).toBe(2);
  });

  it("leaves every other layer on the map's normal maximum", () => {
    for (const id of [
      "precipitationIntensity",
      "temperature",
      "windSpeed",
      "cloudCover",
      "airQuality",
      "modelTemperature",
      "modelPrecipitation",
      "modelWind",
      "unknown-layer",
    ]) {
      expect(maxMapZoomFor(id, MAP_MAX_ZOOM_DEFAULT), id).toBe(
        MAP_MAX_ZOOM_DEFAULT,
      );
    }
    expect(maxMapZoomFor(null, 17)).toBe(17);
    expect(maxMapZoomFor(undefined, 17)).toBe(17);
    expect(maxMapZoomFor("", 17)).toBe(17);
  });

  it("restores the default when the layer goes from a GIBS layer to any other and back", () => {
    const sequence = [
      "satelliteRain",
      "airQuality",
      "satellite",
      "temperature",
      "satelliteRain",
      null,
    ];
    const caps = sequence.map((id) => maxMapZoomFor(id, MAP_MAX_ZOOM_DEFAULT));
    expect(caps).toEqual([
      8,
      MAP_MAX_ZOOM_DEFAULT,
      9,
      MAP_MAX_ZOOM_DEFAULT,
      8,
      MAP_MAX_ZOOM_DEFAULT,
    ]);
  });

  it("eases down to the cap when the map is zoomed past it, and locks it at once otherwise", () => {
    expect(planZoomCap(10, 8)).toEqual({ easeTo: 8, lockNow: false });
    expect(planZoomCap(8.01, 8)).toEqual({ easeTo: 8, lockNow: false });
    expect(planZoomCap(8, 8)).toEqual({ easeTo: null, lockNow: true });
    expect(planZoomCap(6.5, 8)).toEqual({ easeTo: null, lockNow: true });
    // Raising the cap never needs an ease.
    expect(planZoomCap(8, MAP_MAX_ZOOM_DEFAULT)).toEqual({
      easeTo: null,
      lockNow: true,
    });
  });

  it("says what each layer is in its legend note, in plain words", () => {
    const note = (id: string) =>
      MAP_CHIPS.find((c) => c.id === id)?.legend.note;
    expect(note("satelliteRain")).toBe(
      "NASA IMERG, about 10 km grid, smoothed, 4–\u20606 hours behind",
    );
    expect(note("satellite")).toBe(
      "NOAA-20 VIIRS, about 250 m detail, one pass a day",
    );
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

describe("Wildfire layer (NASA GIBS fire detections, drawn through GIBS WMS)", () => {
  it("is the NOAA-20 VIIRS 375 m 'All' layer, daily, drawn from the WMS in EPSG:3857", () => {
    // The ids, the matrix set and the time dimension are from GIBS's own
    // GetCapabilities and DescribeDomains, read 2026-11-05. The capabilities
    // list the layer as Mapbox Vector Tiles only, and the EPSG:3857 .mvt
    // endpoint 404s, so a Web Mercator map draws its WMS rendering instead.
    expect(fire.chipId).toBe("wildfire");
    expect(fire.gibsId).toBe("VIIRS_NOAA20_Thermal_Anomalies_375m_All");
    expect(fire.service).toBe("wms");
    expect(fire.matrixSet).toBe("GoogleMapsCompatible_Level8");
    expect(fire.cadence).toBe("P1D");
    expect(isGibsLayer("wildfire")).toBe(true);
  });

  it("builds a keyless GetMap template for the tile's own bounding box", () => {
    expect(gibsTileUrl(fire, "2026-11-04")).toBe(
      `${GIBS_WMTS_ORIGIN}/wms/epsg3857/best/wms.cgi?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=VIIRS_NOAA20_Thermal_Anomalies_375m_All&STYLES=&FORMAT=image/png&TRANSPARENT=true&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=512&HEIGHT=512&TIME=2026-11-04`,
    );
    expect(gibsTileUrl(fire, "2026-11-04")).not.toMatch(/key|token/i);
    // MapLibre fills the bbox token; none of {z}/{x}/{y} belongs in a WMS URL.
    expect(gibsTileUrl(fire, "2026-11-04")).not.toMatch(/\{[zxy]\}/);
  });

  it("builds a 512 px raster source that overzooms nothing and credits NASA FIRMS", () => {
    const src = buildGibsSource(fire, "2026-11-04");
    expect(src.type).toBe("raster");
    expect(src.tileSize).toBe(GIBS_WMS_TILE_SIZE);
    expect(src.tileSize).toBe(512);
    // Tile zoom = map zoom for 512 px tiles, and the map stops at the same zoom.
    expect(src.maxzoom).toBe(fire.maxMapZoom);
    expect(src.attribution).toContain("NASA FIRMS");
    expect(src.attribution).toContain("NASA GIBS");
  });

  it("smooths only the layer whose data is hard square cells", () => {
    // IMERG (0.1 degree cells) goes through the smoothing protocol; the real
    // GIBS URL, with MapLibre's placeholders, rides inside it.
    expect(imerg.smoothCellDegrees).toBe(0.1);
    const rain = buildGibsSource(imerg, "2026-10-10T14:00:00Z");
    expect(rain.tiles[0].startsWith("mksmooth://0.1/https://")).toBe(true);
    expect(parseSmoothTileUrl(rain.tiles[0])).toEqual({
      url: gibsTileUrl(imerg, "2026-10-10T14:00:00Z"),
      cellDegrees: 0.1,
    });
    expect(rain.tiles[0]).toContain("{z}/{y}/{x}");
    // Imagery and the WMS fire dots have real detail: plain GIBS URLs.
    expect(viirs.smoothCellDegrees).toBeUndefined();
    expect(fire.smoothCellDegrees).toBeUndefined();
    expect(buildGibsSource(viirs, "2026-10-10").tiles[0]).toBe(
      gibsTileUrl(viirs, "2026-10-10"),
    );
    expect(buildGibsSource(fire, "2026-11-04").tiles[0]).toBe(
      gibsTileUrl(fire, "2026-11-04"),
    );
    // Smoothing never changes the credit, the zoom range or the tile size.
    expect(rain.attribution).toContain("NASA GIBS");
    expect(rain.maxzoom).toBe(6);
    expect(rain.tileSize).toBe(256);
  });

  it("keeps the existing GIBS layers on their 256 px WMTS tiles", () => {
    for (const layer of [viirs, imerg]) {
      expect(layer.service).toBe("wmts");
      expect(buildGibsSource(layer, "2026-10-10").tileSize).toBe(256);
      expect(gibsTileUrl(layer, "2026-10-10")).toContain("/wmts/epsg3857/");
    }
  });

  it("asks GIBS which days exist with the same DescribeDomains call as the other layers", () => {
    expect(gibsDomainsUrl(fire, new Date("2026-11-05T03:52:00Z"))).toBe(
      `${GIBS_WMTS_ORIGIN}/wmts/epsg3857/best/1.0.0/VIIRS_NOAA20_Thermal_Anomalies_375m_All/default/GoogleMapsCompatible_Level8/all/2026-10-26--2026-11-06.xml`,
    );
    // The live answer at 03:52 UTC on 2026-11-05: the newest day listed is the 4th.
    const [iv] = parseGibsDomains(
      "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><SpaceDomain/><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-10-26/2026-11-04/P1D</Domain><Size>1</Size></DimensionDomain></Domains>",
    );
    expect(new Date(iv.end).toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(iv.periodMs).toBe(86_400_000);
  });

  describe("credits (generated from MAP_PROVIDERS, never hand-written)", () => {
    it("credits the base map, NASA FIRMS, GIBS and the sensor, in that order", () => {
      expect(attributionForLayer("wildfire").map((p) => p.id)).toEqual([
        "maptiler",
        "osm",
        "nasa-firms",
        "nasa-gibs",
        "nasa-viirs",
      ]);
      expect(overlayAttribution("wildfire").map((p) => p.id)).toEqual([
        "nasa-firms",
        "nasa-gibs",
        "nasa-viirs",
      ]);
    });

    it("uses the acknowledgement NASA asks FIRMS users for", () => {
      const p = MAP_PROVIDERS["nasa-firms"];
      expect(p.label).toBe("Fire data: NASA FIRMS (LANCE, ESDIS)");
      expect(p.href).toBe("https://www.earthdata.nasa.gov/data/tools/firms");
      expect(p.commercialUse).toBe("allowed");
      expect(p.licence).toContain("acknowledgement requested");
    });

    it("renders the credit as a link on the map's own attribution", () => {
      const html = attributionHtml(attributionForLayer("wildfire"));
      expect(html).toContain(
        'href="https://www.earthdata.nasa.gov/data/tools/firms"',
      );
      expect(html).toContain("Fire data: NASA FIRMS (LANCE, ESDIS)");
    });
  });

  describe("frames: the newest days GIBS lists, never a future one", () => {
    const listed = parseGibsDomains(
      "<Domain>2026-10-26/2026-11-04/P1D</Domain>",
    );

    it("offers the newest three UTC days, oldest first, the way GIBS reports them", () => {
      const frames = satelliteFrames(
        fire,
        listed,
        new Date("2026-11-05T03:52:00Z"),
      );
      expect(frames).toEqual([
        { time: "2026-11-02", label: "−3d" },
        { time: "2026-11-03", label: "−2d" },
        { time: "2026-11-04", label: "Yesterday" },
      ]);
    });

    it("offers today as soon as GIBS lists it (a list of detections is real once it has entries)", () => {
      const withToday = parseGibsDomains(
        "<Domain>2026-10-26/2026-11-05/P1D</Domain>",
      );
      const morning = satelliteFrames(
        fire,
        withToday,
        new Date("2026-11-05T06:00:00Z"),
      );
      expect(morning.at(-1)).toEqual({ time: "2026-11-05", label: "Today" });
      // True-colour imagery is a partial mosaic until the afternoon passes are
      // processed, so that layer still waits for 18:00 UTC.
      const imagery = satelliteFrames(
        viirs,
        withToday,
        new Date("2026-11-05T06:00:00Z"),
      );
      expect(imagery.at(-1)!.time).toBe("2026-11-04");
      expect(DAILY_COMPLETE_HOUR_UTC).toBe(18);
    });

    it("never offers a day GIBS has not listed, even when the clock is ahead of the list", () => {
      const frames = satelliteFrames(
        fire,
        listed,
        new Date("2026-11-05T23:59:00Z"),
      );
      expect(frames.at(-1)!.time).toBe("2026-11-04");
    });

    it("never offers a future day, whatever the clock or the list says", () => {
      // A DescribeDomains window can reach a day past now (the request asks for
      // now + 1 day); a WMS answers an unlisted or future date with an XML
      // error, so the loop must never end past the clock.
      const overreach = parseGibsDomains(
        "<Domain>2026-10-26/2026-11-08/P1D</Domain>",
      );
      for (let h = 0; h < 48; h++) {
        const now = new Date(
          Date.parse("2026-11-04T00:00:00Z") + h * 3_600_000,
        );
        for (const intervals of [null, listed, overreach]) {
          for (const f of satelliteFrames(fire, intervals, now)) {
            expect(Date.parse(f.time)).toBeLessThanOrEqual(now.getTime());
          }
        }
      }
    });

    it("falls back to yesterday and the two days before it when the time lookup fails", () => {
      const frames = satelliteFrames(
        fire,
        null,
        new Date("2026-11-05T03:52:00Z"),
      );
      expect(frames.map((f) => f.time)).toEqual([
        "2026-11-02",
        "2026-11-03",
        "2026-11-04",
      ]);
      // Late in the day it is still yesterday: the fallback is generous on
      // purpose, because a day that does not exist yet is an XML error.
      const late = satelliteFrames(
        fire,
        null,
        new Date("2026-11-05T23:00:00Z"),
      );
      expect(late.at(-1)!.time).toBe("2026-11-04");
    });

    it("has exactly the configured number of frames and no repeats", () => {
      const frames = satelliteFrames(
        fire,
        listed,
        new Date("2026-11-05T03:52:00Z"),
      );
      expect(frames).toHaveLength(fire.frames);
      expect(new Set(frames.map((f) => f.time)).size).toBe(frames.length);
    });
  });

  describe("zoom cap (a dot must not claim more precision than the sensor has)", () => {
    /** Metres one CSS pixel covers at a map zoom (512 px tiles) and latitude. */
    const metresPerPx = (zoom: number, latDeg: number) =>
      (40_075_016.68 / (512 * 2 ** zoom)) * Math.cos((latDeg * Math.PI) / 180);
    /** GIBS draws a dot 3 px in radius, 6 px across, at every zoom. */
    const DOT_PX = 6;
    /** VIIRS I-band pixel at nadir; wider toward the edge of the scan. */
    const VIIRS_PIXEL_M = 375;

    it("stops the map at map zoom 10", () => {
      expect(fire.maxMapZoom).toBe(10);
      expect(maxMapZoomFor("wildfire", MAP_MAX_ZOOM_DEFAULT)).toBe(10);
    });

    it("keeps a dot about one sensor pixel wide at the cap over Zimbabwe, and finer than it one zoom deeper", () => {
      const harare = -17.8;
      const atCap = DOT_PX * metresPerPx(fire.maxMapZoom, harare);
      expect(atCap).toBeGreaterThan(VIIRS_PIXEL_M);
      expect(atCap).toBeLessThan(VIIRS_PIXEL_M * 1.5);
      // One zoom deeper a dot would be smaller than the pixel it marks.
      expect(DOT_PX * metresPerPx(fire.maxMapZoom + 1, harare)).toBeLessThan(
        VIIRS_PIXEL_M,
      );
    });

    it("eases a map zoomed past the cap down to it when the layer is chosen", () => {
      expect(planZoomCap(12, fire.maxMapZoom)).toEqual({
        easeTo: 10,
        lockNow: false,
      });
      expect(planZoomCap(8, fire.maxMapZoom)).toEqual({
        easeTo: null,
        lockNow: true,
      });
    });
  });
});

describe("utcDayLabel", () => {
  it("names the UTC day of a daily frame", () => {
    expect(utcDayLabel("2026-11-04")).toBe("4 Nov");
    expect(utcDayLabel("2026-01-31")).toBe("31 Jan");
    // A full instant is still read as its UTC date.
    expect(utcDayLabel("2026-11-04T23:30:00Z")).toBe("4 Nov");
  });

  it("returns what it cannot read, unchanged", () => {
    expect(utcDayLabel("now")).toBe("now");
  });
});
