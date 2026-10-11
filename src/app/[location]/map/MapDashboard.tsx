"use client";

import { Button } from "@/components/ui/button";
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
import { Layers, LayoutList, LocateFixed, Pause, Play, X } from "lucide-react";
import { Breadcrumb } from "@/components/layout/Breadcrumb";
import { MapSkeleton } from "@/components/weather/map/MapSkeleton";
import { WeatherLayerPanel } from "@/components/weather/map/WeatherLayerPanel";
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
import { normalizeForecastModel } from "@/lib/weather";
import { cn } from "@/lib/utils";
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

/** Shared chrome for the round map controls: 48px touch targets on the card surface. */
const CONTROL_CLASS =
  "flex min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] items-center justify-center text-text-primary transition-colors hover:bg-surface-dim";

interface MapDashboardProps {
  location: WeatherLocation;
}

export function MapDashboard({ location }: MapDashboardProps) {
  const router = useRouter();
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
  // Model picker: opens on the user's forecast-model preference.
  const preferredModel = useAppStore((s) => s.selectedForecastModel);
  const setPreferredModel = useAppStore((s) => s.setSelectedForecastModel);
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const activeModel = chosenModel ?? mapModelForPreference(preferredModel);
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
        if (!controller.signal.aborted)
          setDomains({ layer: gibsLayer.chipId, intervals });
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
    const now = new Date();
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
        ? modelTimelineFrames(modelGridData.times)
        : [];
    if (layerSupportsTimeline(activeLayer)) return forecastTimelineFrames(now);
    return [];
  }, [gibsLayer, domains, modelOn, modelGridData, activeLayer]);

  const timelineOn = layerSupportsTimeline(activeLayer) && frames.length > 1;
  const step = Math.min(
    stepChoice ?? timelineDefaultIndex(activeLayer, frames),
    Math.max(frames.length - 1, 0),
  );
  const frameCount = frames.length;
  // Playback only runs while a timeline layer is showing.
  const isPlaying = playing && timelineOn;

  const handleLayerChange = useCallback((id: string) => {
    setChosenLayer(id);
    setPlaying(false);
    setStepChoice(null);
    writeStoredMapLayer(getStorage(), id);
  }, []);

  const handleModelChange = useCallback(
    (id: string) => {
      setChosenModel(id);
      setStepChoice(null);
      // The dashboard preference only takes the models its picker offers;
      // GEM and ARPEGE stay a map-only choice.
      if (normalizeForecastModel(id) === id) setPreferredModel(id);
    },
    [setPreferredModel],
  );

  useEffect(() => {
    if (!isPlaying || frameCount < 2) return;
    const id = window.setInterval(
      () =>
        setStepChoice((s) => {
          const current = s ?? 0;
          return (current + 1) % frameCount;
        }),
      TIMELINE_TICK_MS,
    );
    return () => window.clearInterval(id);
  }, [isPlaying, frameCount]);

  const fieldOverlay: FieldOverlay | null = useMemo(() => {
    if (!modelOn) return null;
    const data = modelGridToGeoJSON(modelGridData, activeLayer, step);
    if (!data) return null;
    return {
      data,
      tokens: modelLegendTokens(getMapChip(activeLayer)?.legend),
      attribution: attributionHtml(
        overlayAttribution(activeLayer, activeModel),
      ),
    };
  }, [modelOn, modelGridData, activeLayer, step, activeModel]);

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

  const handleLocate = useCallback(async () => {
    if (locating) return;
    setLocating(true);
    setLocateMessage(null);
    const result = await detectUserLocation({ autoCreate: true });
    if (result.location) {
      router.push(`/${result.location.slug}/map`);
      return;
    }
    setLocating(false);
    setLocateMessage(
      result.status === "denied"
        ? "Location access is off. Allow it in your browser settings."
        : "We could not find your location. Try again.",
    );
  }, [locating, router]);

  const chip = getMapChip(activeLayer);

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

      {/* Top-left: close (back to the location), the shared breadcrumb trail
          as a compact overlay pill, and the legend for the active layer.
          The column stops 7rem short of the right edge, so neither the
          close button nor the trail can run under the control stack. */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex w-[min(20rem,calc(100%-7rem))] flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/${location.slug}`}
            aria-label={`Close map and return to ${location.name}`}
            className="pointer-events-auto flex h-[var(--touch-target-min)] w-[var(--touch-target-min)] shrink-0 items-center justify-center rounded-full bg-surface-card text-text-primary shadow-md ring-1 ring-border hover:bg-surface-dim"
          >
            <X className="h-5 w-5" aria-hidden="true" />
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

        {chip && (
          <section
            aria-labelledby="map-legend-title"
            className="pointer-events-auto rounded-[var(--radius-card)] bg-surface-card p-3 shadow-md ring-1 ring-border"
          >
            <h2
              id="map-legend-title"
              className="font-mono text-xs uppercase tracking-wide text-text-tertiary"
            >
              {chip.label} · {chip.legend.unit}
            </h2>
            {chip.legend.segments.length > 0 && (
              <>
                <div
                  className="mt-2 flex h-2 gap-px overflow-hidden rounded-full"
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
                  className="mt-1 flex justify-between text-xs text-text-tertiary"
                  aria-hidden="true"
                >
                  {chip.legend.segments.map((seg) => (
                    <span key={seg.label}>{seg.label}</span>
                  ))}
                </div>
              </>
            )}
            {chip.legend.note && (
              <p className="mt-1 text-xs text-text-tertiary">
                {chip.legend.note}
              </p>
            )}
            {modelOn && (
              <p className="mt-2 text-sm text-text-secondary" role="status">
                {!modelCurrent && "Loading model forecast…"}
                {modelCurrent &&
                  !modelGridData?.available &&
                  "This model's forecast is unavailable right now."}
                {modelCurrent &&
                  modelGridData?.available &&
                  `${getMapModel(activeModel)?.label ?? activeModel} · ${frames[step]?.label ?? "Now"}`}
              </p>
            )}
            {!sheetOpen && <MapCredits credits={credits} />}
            {aqOn && (
              <p className="mt-2 text-sm text-text-secondary" role="status">
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
          </section>
        )}
      </div>

      {/* Top-right: stacked controls (layers, my location) and the location list. */}
      <div className="pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-2">
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-[var(--radius-card)] bg-surface-card shadow-md ring-1 ring-border">
          <button
            type="button"
            onClick={() => setSheetOpen((open) => !open)}
            aria-pressed={sheetOpen}
            aria-label={sheetOpen ? "Hide layer panel" : "Show layer panel"}
            className={CONTROL_CLASS}
          >
            <Layers className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleLocate}
            disabled={locating}
            aria-busy={locating}
            aria-label="Centre the map on my location"
            className={cn(CONTROL_CLASS, "border-t border-border")}
          >
            <LocateFixed className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <Link
          href="/locations"
          aria-label="Browse all locations"
          className={cn(
            "pointer-events-auto rounded-full bg-surface-card shadow-md ring-1 ring-border",
            CONTROL_CLASS,
          )}
        >
          <LayoutList className="h-5 w-5" aria-hidden="true" />
        </Link>
        {locateMessage && (
          <p
            role="status"
            className="pointer-events-auto max-w-[12rem] rounded-[var(--radius-card)] bg-surface-card p-2 text-xs text-text-secondary shadow-md ring-1 ring-border"
          >
            {locateMessage}
          </p>
        )}
      </div>

      {/* Bottom sheet: labelled layer chips and, for rain, the forecast timeline. */}
      {sheetOpen && (
        <section
          aria-labelledby="map-layers-title"
          className="absolute inset-x-0 bottom-0 z-10 rounded-t-[var(--radius-card)] bg-surface-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-lg ring-1 ring-border"
        >
          <h2 id="map-layers-title" className="sr-only">
            Map layers and forecast time
          </h2>
          <WeatherLayerPanel
            activeLayer={activeLayer}
            onLayerChange={handleLayerChange}
            locationSlug={location.slug}
            chips={chips}
            models={modelOn ? MAP_MODELS : undefined}
            activeModel={activeModel}
            onModelChange={handleModelChange}
          />

          {timelineOn && (
            <div className="mt-2 flex items-center gap-3">
              <Button
                type="button"
                size="icon-sm"
                onClick={() => setPlaying((p) => !p)}
                aria-pressed={isPlaying}
                aria-label={
                  isPlaying
                    ? "Pause forecast timeline"
                    : "Play forecast timeline"
                }
                className="shrink-0"
              >
                {isPlaying ? (
                  <Pause className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Play className="h-5 w-5" aria-hidden="true" />
                )}
              </Button>
              <div className="flex min-w-0 flex-1 flex-col">
                <input
                  type="range"
                  min={0}
                  max={frames.length - 1}
                  step={1}
                  value={step}
                  onChange={(e) => {
                    setPlaying(false);
                    setStepChoice(Number(e.target.value));
                  }}
                  aria-label={gibsLayer ? "Observation time" : "Forecast time"}
                  aria-valuetext={frames[step]?.label ?? ""}
                  className="h-[var(--touch-target-min)] w-full accent-primary"
                />
                <div
                  className="flex justify-between text-xs text-text-tertiary"
                  aria-hidden="true"
                >
                  {timelineAxisLabels(frames).map((label, i) => (
                    <span key={`${label}-${i}`}>{label}</span>
                  ))}
                </div>
              </div>
              <span
                className="w-12 shrink-0 text-right font-mono text-sm text-text-primary"
                aria-live="polite"
              >
                {frames[step]?.label ?? ""}
              </span>
            </div>
          )}
          <MapCredits credits={credits} className="text-center" />
        </section>
      )}
    </main>
  );
}

/**
 * The map's credits for the active layer, generated from map-sources.ts so
 * every provider whose data is on screen is named. Shown in the bottom sheet,
 * and in the legend card while the sheet is hidden, so the map is never
 * without its attribution.
 */
function MapCredits({
  credits,
  className,
}: {
  credits: ReturnType<typeof attributionForLayer>;
  className?: string;
}) {
  return (
    <p className={cn("mt-2 text-xs text-text-tertiary", className)}>
      <span className="sr-only">Map and data sources: </span>
      {credits.map((p, i) => (
        <span key={p.id}>
          {i > 0 && " · "}
          <a
            href={p.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {p.label}
          </a>
        </span>
      ))}
    </p>
  );
}
