"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Layers, LayoutList, LocateFixed, X } from "lucide-react";
import { Breadcrumb } from "@/components/layout/Breadcrumb";
import { MapSkeleton } from "@/components/weather/map/MapSkeleton";
import {
  WeatherLayerPanel,
  LayerIcon,
} from "@/components/weather/map/WeatherLayerPanel";
import { MapTimeline } from "@/components/weather/map/MapTimeline";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { useMziziHarness } from "@/lib/harness";
import {
  hasFixedUtcOffset,
  resolveUtcOffsetSeconds,
} from "@/lib/location-card";
import { fetchPlaceOffset, type PlaceOffset } from "@/lib/map-timeline";
import { detectUserLocation } from "@/lib/geolocation";
import {
  AQI_BAND_LABELS,
  aqBubbles,
  aqiBand,
  fetchAirQualityGrid,
  gridToGeoJSON,
  type AqGridResponse,
} from "@/lib/aq-grid";
import {
  AIR_QUALITY_LAYER_ID,
  DEFAULT_LAYER,
  forecastTimelineFrames,
  getMapChip,
  isModelLayer,
  layerSupportsTimeline,
  mapChipsFor,
  modelTimelineFrames,
  readStoredMapLayer,
  timelineAxisLabels,
  timelineDefaultIndex,
  writeStoredMapLayer,
  type TimelineFrame,
} from "@/lib/map-layers";
import {
  MAP_MODELS,
  attributionForLayer,
  attributionHtml,
  fetchGibsDomains,
  getGibsLayer,
  getMapModel,
  mapModelForPreference,
  overlayAttribution,
  satelliteFrames,
  type TimeInterval,
} from "@/lib/map-sources";
import {
  fetchModelGrid,
  modelGridToGeoJSON,
  modelLegendTokens,
  type ModelGridResponse,
} from "@/lib/model-grid";
import { getFeatureFlag } from "@/lib/feature-flags";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { MapCredits } from "@/components/weather/map/MapCredits";
import type { WeatherLocation } from "@/lib/locations";
import type { FieldOverlay } from "@/components/weather/map/MapLibreMap";

const MapLibreMap = dynamic(
  () =>
    import("@/components/weather/map/MapLibreMap").then((m) => ({
      default: m.MapLibreMap,
    })),
  { ssr: false, loading: () => <MapSkeleton fill className="rounded-none" /> },
);

/** Milliseconds per timeline stop while playing. */
const TIMELINE_TICK_MS = 900;

/** Storage handle, or null when the browser blocks localStorage (it can throw on access). */
function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** External store with no subscription: localStorage is read on each render. */
function subscribeNoop(): () => void {
  return () => {};
}

/** Every map control icon: one size, one stroke (Lucide default). */
const ICON_CLASS = "h-5 w-5";

interface MapDashboardProps {
  location: WeatherLocation;
}

export function MapDashboard({ location }: MapDashboardProps) {
  const router = useRouter();
  const { announce } = useMziziHarness("map-dashboard");
  // True once hydrated: clock-dependent labels wait for it, so SSR and the
  // first client render agree (the timeline reads "Now" until then).
  const hydrated = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  // Model-field chips sit behind a flag (Open-Meteo's free API is
  // non-commercial). Read like the stored layer so SSR renders the default.
  const modelLayersOn = useSyncExternalStore(
    subscribeNoop,
    () => getFeatureFlag("model_map_layers"),
    () => false,
  );
  const chips = useMemo(
    () => mapChipsFor({ modelLayers: modelLayersOn }),
    [modelLayersOn],
  );
  // The remembered layer is read from localStorage through useSyncExternalStore:
  // the server snapshot is the default, so SSR and the first client render agree
  // and the stored choice applies without a setState-in-effect.
  const storedLayer = useSyncExternalStore(
    subscribeNoop,
    () => readStoredMapLayer(getStorage(), chips) ?? DEFAULT_LAYER,
    () => DEFAULT_LAYER,
  );
  // A choice made in this visit overrides the stored value.
  const [chosenLayer, setChosenLayer] = useState<string | null>(null);
  const activeLayer = chosenLayer ?? storedLayer;
  const [sheetOpen, setSheetOpen] = useState(true);
  // null = the layer's default frame (Now for forecasts, newest for imagery).
  const [stepChoice, setStepChoice] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // Model picker: opens on the user's forecast-model preference. Picking a
  // model here only changes the map — the preference drives every location
  // page's baseline, so comparing models on the map must not switch it.
  const preferredModel = useAppStore((s) => s.selectedForecastModel);
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  // Re-derive "now" for the timelines every few minutes on a long-open tab.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []);
  const activeModel = chosenModel ?? mapModelForPreference(preferredModel);
  // The place's UTC offset, so the timeline reads in its wall clock. A
  // fixed-offset country (no DST) is exact from the table; anywhere else the
  // longitude estimate is shown as approximate until our cached weather API
  // returns the real, DST-aware offset.
  const fixedOffset = hasFixedUtcOffset(location.country);
  const estimate = resolveUtcOffsetSeconds(
    null,
    location.lon,
    location.country,
  );
  const placeKey = `${location.lat},${location.lon}`;
  const [fetchedOffset, setFetchedOffset] = useState<{
    key: string;
    offset: PlaceOffset | null;
  } | null>(null);
  useEffect(() => {
    if (fixedOffset) return;
    const controller = new AbortController();
    void fetchPlaceOffset(location.lat, location.lon, controller.signal).then(
      (offset) => {
        if (!controller.signal.aborted)
          setFetchedOffset({ key: placeKey, offset });
      },
    );
    return () => controller.abort();
  }, [fixedOffset, location.lat, location.lon, placeKey]);
  const apiOffset =
    fetchedOffset?.key === placeKey ? fetchedOffset.offset : null;
  const offsetSeconds = apiOffset?.offsetSeconds ?? estimate;
  const offsetApproximate =
    !fixedOffset && (apiOffset === null || apiOffset.estimated);
  // GIBS time domains and model grids, each tagged with what they were fetched for.
  const [domains, setDomains] = useState<{
    layer: string;
    intervals: TimeInterval[] | null;
  } | null>(null);
  const [modelGrid, setModelGrid] = useState<{
    key: string;
    grid: ModelGridResponse | null;
  } | null>(null);
  // Grid result tagged with the coordinate it was fetched for. Anything tagged
  // with another coordinate counts as loading, so no state is reset in an effect.
  const [gridResult, setGridResult] = useState<{
    key: string;
    grid: AqGridResponse | null;
  } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateMessage, setLocateMessage] = useState<string | null>(null);

  const aqOn = activeLayer === AIR_QUALITY_LAYER_ID;
  const gibsLayer = getGibsLayer(activeLayer);
  const modelOn = isModelLayer(activeLayer);

  // NASA GIBS: look up which frames exist (DescribeDomains) while a satellite
  // layer is active. Until it answers, frames come from a fixed latency.
  useEffect(() => {
    if (!gibsLayer) return;
    const controller = new AbortController();
    void fetchGibsDomains(gibsLayer, new Date(), controller.signal).then(
      (intervals) => {
        if (controller.signal.aborted) return;
        setDomains({ layer: gibsLayer.chipId, intervals });
        // The real frames replace the fixed-latency guess: reopen on the newest.
        setStepChoice(null);
      },
    );
    return () => controller.abort();
  }, [gibsLayer]);

  // Model fields: one grid per (model, location) while a model chip is active.
  const modelKey = `${activeModel}:${location.lat},${location.lon}`;
  useEffect(() => {
    if (!modelOn) return;
    const controller = new AbortController();
    fetchModelGrid({
      lat: location.lat,
      lon: location.lon,
      model: activeModel,
      signal: controller.signal,
    })
      .then((grid) => {
        if (!controller.signal.aborted) setModelGrid({ key: modelKey, grid });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setModelGrid({ key: modelKey, grid: null });
      });
    return () => controller.abort();
  }, [modelOn, activeModel, location.lat, location.lon, modelKey]);
  const modelCurrent = modelGrid?.key === modelKey ? modelGrid : null;
  const modelGridData = modelCurrent?.grid ?? null;

  const frames: TimelineFrame[] = useMemo(() => {
    const now = new Date(clock);
    if (gibsLayer) {
      const intervals =
        domains?.layer === gibsLayer.chipId ? domains.intervals : null;
      return satelliteFrames(gibsLayer, intervals, now).map((f) => ({
        timestamp: f.time,
        label: f.label,
      }));
    }
    if (modelOn)
      return modelGridData?.available
        ? modelTimelineFrames(modelGridData.times, now)
        : [];
    if (layerSupportsTimeline(activeLayer)) return forecastTimelineFrames(now);
    return [];
  }, [gibsLayer, domains, modelOn, modelGridData, activeLayer, clock]);

  const timelineOn = layerSupportsTimeline(activeLayer) && frames.length > 1;
  const defaultStep = timelineDefaultIndex(activeLayer, frames);
  const step = Math.min(
    stepChoice ?? defaultStep,
    Math.max(frames.length - 1, 0),
  );
  const frameCount = frames.length;
  // Playback only runs while a timeline layer is showing AND its controls are
  // on screen: collapsing the sheet hides the pause button, so it stops too.
  const isPlaying = playing && timelineOn && sheetOpen;

  const handleLayerChange = useCallback(
    (id: string) => {
      setChosenLayer(id);
      setPlaying(false);
      setStepChoice(null);
      writeStoredMapLayer(getStorage(), id);
      const next = getMapChip(id);
      if (next) announce(`${next.label} layer, ${next.legend.unit}`);
    },
    [announce],
  );

  const handleModelChange = useCallback((id: string) => {
    setChosenModel(id);
    setStepChoice(null);
  }, []);

  useEffect(() => {
    if (!isPlaying || frameCount < 2) return;
    const id = window.setInterval(
      () =>
        setStepChoice((s) => {
          // Continue from the frame on screen (imagery opens on the newest).
          const current = s ?? defaultStep;
          return (current + 1) % frameCount;
        }),
      TIMELINE_TICK_MS,
    );
    return () => window.clearInterval(id);
  }, [isPlaying, frameCount, defaultStep]);

  const fieldOverlay: FieldOverlay | null = useMemo(() => {
    if (!modelOn) return null;
    // Frames skip steps that are already past, so map the frame back to the
    // grid's series index by its time.
    const seriesIndex =
      modelGridData?.times.indexOf(frames[step]?.timestamp ?? "") ?? -1;
    if (seriesIndex < 0) return null;
    const data = modelGridToGeoJSON(modelGridData, activeLayer, seriesIndex);
    if (!data) return null;
    return {
      data,
      tokens: modelLegendTokens(getMapChip(activeLayer)?.legend),
      attribution: attributionHtml(
        overlayAttribution(activeLayer, activeModel),
      ),
    };
  }, [modelOn, modelGridData, activeLayer, step, frames, activeModel]);

  const credits = attributionForLayer(activeLayer, activeModel);

  // Air quality: fetch the grid for this location while the AQ chip is active.
  const gridKey = `${location.lat},${location.lon}`;
  useEffect(() => {
    if (!aqOn) return;
    const controller = new AbortController();
    fetchAirQualityGrid({
      lat: location.lat,
      lon: location.lon,
      signal: controller.signal,
    })
      .then((res) => {
        if (!controller.signal.aborted)
          setGridResult({ key: gridKey, grid: res });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setGridResult({ key: gridKey, grid: null });
      });
    return () => controller.abort();
  }, [aqOn, location.lat, location.lon, gridKey]);

  const gridCurrent = gridResult?.key === gridKey ? gridResult : null;
  const grid = gridCurrent?.grid ?? null;
  const gridState: "loading" | "error" | "ready" = !gridCurrent
    ? "loading"
    : gridCurrent.grid
      ? "ready"
      : "error";

  const aqFill = useMemo(
    () => (grid?.available ? gridToGeoJSON(grid.points, grid.cellKm) : null),
    [grid],
  );
  const bubbles = useMemo(() => (grid ? aqBubbles(grid) : null), [grid]);
  const centerAqi = grid?.center?.aqi ?? null;
  const centerBand = centerAqi === null ? null : aqiBand(centerAqi);

  // Collapsing hides the pause button, so it also clears `playing`: expanding
  // again must not restart playback on its own.
  const toggleSheet = useCallback(() => {
    setSheetOpen((open) => !open);
    setPlaying(false);
  }, []);

  const handleLocate = useCallback(async () => {
    if (locating) return;
    setLocating(true);
    setLocateMessage(null);
    const result = await detectUserLocation({ autoCreate: true });
    if (result.location) {
      if (result.location.slug === location.slug) {
        // Already on this place: a push to the same URL would not remount.
        setLocating(false);
        setLocateMessage("You are already viewing your location.");
        return;
      }
      router.push(`/${result.location.slug}/map`);
      return;
    }
    setLocating(false);
    setLocateMessage(
      result.status === "denied"
        ? "Location access is off. Allow it in your browser settings."
        : "We could not find your location. Try again.",
    );
  }, [locating, router, location.slug]);

  const chip = getMapChip(activeLayer);
  const sheetId = "map-sheet-body";
  // Forward timelines (rain, model fields) read in the place's clock;
  // observed satellite loops keep each frame's own "−3h" label.
  const now = useMemo(
    () => (hydrated ? new Date(clock) : null),
    [hydrated, clock],
  );
  const timelineZone = useMemo(
    () =>
      gibsLayer
        ? null
        : {
            offsetSeconds,
            zoneName: location.name,
            approximate: offsetApproximate,
            now,
          },
    [gibsLayer, offsetSeconds, location.name, offsetApproximate, now],
  );

  return (
    <main
      id="main-content"
      className="relative h-[100dvh] w-full overflow-hidden"
      aria-label={`Weather map for ${location.name}`}
    >
      <h1 className="sr-only">{location.name} weather map</h1>

      <MapLibreMap
        lat={location.lat}
        lon={location.lon}
        zoom={8}
        interactive
        weatherLayer={aqOn || modelOn ? null : activeLayer}
        weatherTimestamp={
          timelineOn && !modelOn ? (frames[step]?.timestamp ?? "now") : "now"
        }
        aqiOverlay={aqOn ? aqFill : null}
        fieldOverlay={fieldOverlay}
        aqiBubbles={aqOn ? bubbles : null}
        navigationControl={false}
        attributionControl={false}
        className="h-full w-full"
      />

      {/* Top-left: close (back to the location) and the shared breadcrumb
          trail as a compact overlay pill. The column stops 7rem short of the
          right edge, so neither can run under the control stack. */}
      <div className="pointer-events-none absolute left-4 top-[max(1rem,env(safe-area-inset-top))] z-10 flex w-[min(20rem,calc(100%-7rem))] min-w-0 items-center gap-2">
        <Link
          href={`/${location.slug}`}
          aria-label={`Close map and return to ${location.name}`}
          className="serval duiker pointer-events-auto rounded-full text-text-primary"
        >
          <X className={ICON_CLASS} aria-hidden="true" />
        </Link>
        <Breadcrumb
          variant="overlay"
          items={[
            { label: "Home", href: "/" },
            { label: location.name, href: `/${location.slug}` },
            { label: "Map" },
          ]}
        />
      </div>

      {/* Top-right: stacked controls (layer sheet, my location) and the list. */}
      <div className="pointer-events-none absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 flex flex-col items-end gap-2">
        <div className="serval pointer-events-auto flex flex-col overflow-hidden p-0.5">
          <button
            type="button"
            onClick={toggleSheet}
            aria-expanded={sheetOpen}
            aria-controls={sheetId}
            aria-label={sheetOpen ? "Hide map layers" : "Show map layers"}
            className="duiker text-text-primary"
          >
            <Layers className={ICON_CLASS} aria-hidden="true" />
          </button>
          <span aria-hidden="true" className="mx-2 h-px bg-border" />
          <button
            type="button"
            onClick={handleLocate}
            disabled={locating}
            aria-busy={locating}
            aria-label="Centre the map on my location"
            className="duiker text-text-primary"
          >
            <LocateFixed className={ICON_CLASS} aria-hidden="true" />
          </button>
        </div>
        <Link
          href="/locations"
          aria-label="Browse all locations"
          className="serval duiker pointer-events-auto rounded-full text-text-primary"
        >
          <LayoutList className={ICON_CLASS} aria-hidden="true" />
        </Link>
        {locateMessage && (
          <p
            role="status"
            className="serval pointer-events-auto max-w-[12rem] p-2 text-sm text-text-secondary"
          >
            {locateMessage}
          </p>
        )}
      </div>

      {/* Bottom sheet: a floating card in the same language as the top
          controls. The header (active layer + legend with units) and the
          credits for every provider on screen are always shown; the layer
          chips, model picker and timeline collapse, so the sheet never has
          to hide the map entirely and the licence credit never disappears.
          On a short (landscape phone) viewport it anchors left and narrows,
          so the map stays visible. */}
      <section
        aria-labelledby="map-legend-title"
        data-slot="map-sheet"
        className="serval absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] z-10 mx-auto flex max-h-[calc(100dvh-6rem)] max-w-xl flex-col overflow-y-auto px-4 pb-2 pt-3 [@media(max-height:500px)]:mr-auto [@media(max-height:500px)]:max-w-md"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          >
            <LayerIcon id={activeLayer} className={ICON_CLASS} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="map-legend-title"
              className="flex items-baseline gap-2 text-base font-semibold text-text-primary"
            >
              {chip?.label ?? "Map"}
              {chip && (
                <span className="font-mono text-sm font-normal text-text-tertiary">
                  {chip.legend.unit}
                </span>
              )}
            </h2>
            {chip && chip.legend.segments.length > 0 && (
              <>
                <div
                  className="mt-1.5 flex h-2 gap-px overflow-hidden rounded-full ring-1 ring-border"
                  aria-hidden="true"
                >
                  {chip.legend.segments.map((seg) => (
                    <span
                      key={seg.label}
                      className={cn("flex-1", seg.className)}
                    />
                  ))}
                </div>
                <div
                  className="mt-1 flex justify-between font-mono text-sm text-text-tertiary"
                  aria-hidden="true"
                >
                  {chip.legend.segments.map((seg) => (
                    <span key={seg.label}>{seg.label}</span>
                  ))}
                </div>
                <p className="sr-only">
                  Legend, {chip.legend.unit}:{" "}
                  {chip.legend.segments.map((seg) => seg.label).join(", ")}
                </p>
              </>
            )}
            {chip?.legend.note && (
              <p className="mt-1 text-sm text-text-tertiary">
                {chip.legend.note}
              </p>
            )}
            {modelOn && (
              <p className="mt-1 text-sm text-text-secondary" role="status">
                {!modelCurrent && "Loading model forecast…"}
                {modelCurrent &&
                  !modelGridData?.available &&
                  "This model's forecast is unavailable right now."}
                {modelCurrent &&
                  modelGridData?.available &&
                  `${getMapModel(activeModel)?.label ?? activeModel} · ${frames[step]?.label ?? "Now"}`}
              </p>
            )}
            {aqOn && (
              <p className="mt-1 text-sm text-text-secondary" role="status">
                {gridState === "loading" && "Loading air quality…"}
                {gridState === "error" &&
                  "Air quality is unavailable right now."}
                {gridState === "ready" &&
                  centerAqi === null &&
                  "No air quality reading for this area."}
                {gridState === "ready" &&
                  centerAqi !== null &&
                  centerBand !== null &&
                  `${location.name}: ${Math.round(centerAqi)}, ${AQI_BAND_LABELS[centerBand]}`}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={toggleSheet}
            aria-expanded={sheetOpen}
            aria-controls={sheetId}
            aria-label={sheetOpen ? "Collapse map layers" : "Expand map layers"}
            className="duiker -mr-2 -mt-1"
          >
            <ChevronDown
              className={cn(
                ICON_CLASS,
                "transition-transform",
                !sheetOpen && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
        </div>

        <div id={sheetId} hidden={!sheetOpen} className="mt-3">
          <h3 className="sr-only">Map layers and time</h3>
          <ChartErrorBoundary name="map layers">
            <WeatherLayerPanel
              activeLayer={activeLayer}
              onLayerChange={handleLayerChange}
              locationSlug={location.slug}
              chips={chips}
              models={modelOn ? MAP_MODELS : undefined}
              activeModel={activeModel}
              onModelChange={handleModelChange}
            />
          </ChartErrorBoundary>
          {timelineOn && (
            <div className="mt-3 border-t border-border pt-2">
              <ChartErrorBoundary name="timeline">
                <MapTimeline
                  frames={frames}
                  step={step}
                  playing={isPlaying}
                  onStepChange={setStepChoice}
                  onPlayingChange={setPlaying}
                  zone={timelineZone}
                  inputLabel={gibsLayer ? "Observation time" : "Forecast time"}
                />
              </ChartErrorBoundary>
            </div>
          )}
        </div>

        <MapCredits credits={credits} className="text-center" />
      </section>
    </main>
  );
}
