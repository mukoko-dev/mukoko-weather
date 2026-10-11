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
import { useMziziHarness } from "@/lib/harness";
import {
  hasFixedUtcOffset,
  resolveUtcOffsetSeconds,
} from "@/lib/location-card";
import { fetchPlaceOffset, type PlaceOffset } from "@/lib/map-timeline";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
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
  TIMELINE_STEPS,
  getMapChip,
  layerSupportsTimeline,
  readStoredMapLayer,
  timelineTimestamp,
  writeStoredMapLayer,
} from "@/lib/map-layers";
import { cn } from "@/lib/utils";
import type { WeatherLocation } from "@/lib/locations";

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

/**
 * Minute-granular clock for the timeline labels. The server snapshot is 0
 * ("no clock yet"), so SSR and hydration agree and the labels appear on the
 * client without a setState-in-effect.
 */
function subscribeMinute(onTick: () => void): () => void {
  const id = window.setInterval(onTick, 30_000);
  return () => window.clearInterval(id);
}
function minuteNow(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}
function noClock(): number {
  return 0;
}

interface MapDashboardProps {
  location: WeatherLocation;
}

export function MapDashboard({ location }: MapDashboardProps) {
  const router = useRouter();
  const { announce } = useMziziHarness("map-dashboard");
  const minute = useSyncExternalStore(subscribeMinute, minuteNow, noClock);
  const clock = useMemo(() => (minute ? new Date(minute) : null), [minute]);
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
  // The remembered layer is read from localStorage through useSyncExternalStore:
  // the server snapshot is the default, so SSR and the first client render agree
  // and the stored choice applies without a setState-in-effect.
  const storedLayer = useSyncExternalStore(
    subscribeNoop,
    () => readStoredMapLayer(getStorage()) ?? DEFAULT_LAYER,
    () => DEFAULT_LAYER,
  );
  // A choice made in this visit overrides the stored value.
  const [chosenLayer, setChosenLayer] = useState<string | null>(null);
  const activeLayer = chosenLayer ?? storedLayer;
  const [sheetOpen, setSheetOpen] = useState(true);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Grid result tagged with the coordinate it was fetched for. Anything tagged
  // with another coordinate counts as loading, so no state is reset in an effect.
  const [gridResult, setGridResult] = useState<{
    key: string;
    grid: AqGridResponse | null;
  } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateMessage, setLocateMessage] = useState<string | null>(null);

  const aqOn = activeLayer === AIR_QUALITY_LAYER_ID;
  const timelineOn = layerSupportsTimeline(activeLayer);
  // Playback only runs while a timeline layer is showing AND its controls are
  // on screen: collapsing the sheet hides the pause button, so it stops too.
  const isPlaying = playing && timelineOn && sheetOpen;

  const handleLayerChange = useCallback(
    (id: string) => {
      setChosenLayer(id);
      setPlaying(false);
      writeStoredMapLayer(getStorage(), id);
      const next = getMapChip(id);
      if (next) announce(`${next.label} layer, ${next.legend.unit}`);
    },
    [announce],
  );

  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(
      () => setStep((s) => (s + 1) % TIMELINE_STEPS),
      TIMELINE_TICK_MS,
    );
    return () => window.clearInterval(id);
  }, [isPlaying]);

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
  const sheetId = "map-sheet-body";

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
        weatherLayer={aqOn ? null : activeLayer}
        weatherTimestamp={
          timelineOn ? timelineTimestamp(step, clock ?? new Date()) : "now"
        }
        aqiOverlay={aqOn ? aqFill : null}
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
            onClick={() => setSheetOpen((open) => !open)}
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
          attribution are always shown; the layer chips and the timeline
          collapse, so the sheet never has to hide the map entirely and the
          licence credit never disappears. On a short (landscape phone)
          viewport it anchors left and narrows, so the map stays visible.
          Room for more rows (a model picker, a richer attribution control)
          sits below the timeline. */}
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
            {chip && (
              <>
                <div
                  className="mt-1.5 flex h-2 gap-px overflow-hidden rounded-full"
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
            onClick={() => setSheetOpen((open) => !open)}
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
          <h3 className="sr-only">Map layers and forecast time</h3>
          <ChartErrorBoundary name="map layers">
            <WeatherLayerPanel
              activeLayer={activeLayer}
              onLayerChange={handleLayerChange}
              locationSlug={location.slug}
            />
          </ChartErrorBoundary>
          {timelineOn && (
            <div className="mt-3 border-t border-border pt-2">
              <ChartErrorBoundary name="forecast timeline">
                <MapTimeline
                  step={step}
                  playing={isPlaying}
                  onStepChange={setStep}
                  onPlayingChange={setPlaying}
                  offsetSeconds={offsetSeconds}
                  zoneName={location.name}
                  approximate={offsetApproximate}
                  now={clock}
                />
              </ChartErrorBoundary>
            </div>
          )}
        </div>

        <p className="mt-1 text-center text-sm text-text-tertiary">
          Map ©{" "}
          <a
            href="https://www.maptiler.com/"
            className="underline underline-offset-2"
          >
            MapTiler
          </a>{" "}
          ©{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            className="underline underline-offset-2"
          >
            OpenStreetMap
          </a>
        </p>
      </section>
    </main>
  );
}
