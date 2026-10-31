"use client";

import { roundCoord } from "@/lib/location-privacy";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type {
  CurrentWeather,
  HourlyWeather,
  DailyWeather,
  WeatherData,
} from "@/lib/weather";
import {
  currentWallHourMs,
  locationDateString,
  resolveOffsetSeconds,
  wallClockMs,
} from "@/lib/location-time";
import { SectionHeader } from "@/components/ui/section-header";
import { LazySection } from "./LazySection";
import { ChartErrorBoundary } from "./ChartErrorBoundary";
import {
  humidityInsight,
  pressureInsight,
  sunInsight,
  windInsight,
  uvInsight,
  feelsLikeInsight,
  precipitationInsight,
  visibilityInsight,
  temperatureAverageInsight,
} from "@/lib/metric-insights";
import { moonPhase } from "@/lib/moon";
import { seedNowMs, useStableNow } from "@/lib/use-stable-now";
import { useNearViewport } from "@/lib/use-near-viewport";
import { AQI_BAND_LABELS, aqiBand } from "@/lib/aq-grid";
import { lastTileSpanClass } from "@/lib/dashboard-layout";
import {
  METRIC_TITLES,
  moonriseLabel,
  type MetricKind,
} from "@/lib/metric-details";
import { nextMoonrise } from "@/lib/moon";
import { MetricDetailModal } from "./MetricDetailModal";
import { AirQualityDetail } from "./AirQualityDetail";
import { aqiScalePct } from "@/lib/air-quality-details";
import { cn } from "@/lib/utils";
import {
  CloudIcon,
  CloudRainIcon,
  DropletIcon,
  EyeIcon,
  GaugeIcon,
  MoonIcon,
  SunIcon,
  SunriseIcon,
  ThermometerIcon,
  WindIcon,
} from "@/lib/weather-icons";
import {
  InsightCard,
  InsightGrid,
  CompassDial,
  GradientScale,
  MiniBars,
  MoonDisc,
  PressureDial,
  ScaleReadout,
  SunArc,
} from "./widgets";
import { POLLUTANT_LABELS, type AirQualityResponse } from "./AirQualityCard";
import { AirQualityWideSkeleton } from "./SectionSkeleton";
import { fetchWorker } from "@/lib/weather-api";

interface Props {
  current: CurrentWeather;
  /**
   * Full forecast. Drives the time-aware insight cards (UV peak, next-24h rain,
   * sun arc, averages). Optional so callers that only hold `current` still
   * render the instantaneous cards.
   */
  weather?: WeatherData;
  /** Optional location coords — when supplied, the AQI card and normals load. */
  lat?: number;
  lon?: number;
  /** Rendered directly under the AQI card (e.g. the haze panel). */
  afterAirQuality?: ReactNode;
}

// ── Mineral edges ───────────────────────────────────────────────────────────
// Each card carries a 4px mineral leading edge chosen by the data's role, so
// colour reads as meaning (travel, sun, moisture) rather than as decoration.
// Literal class names so Tailwind generates them.

type Mineral =
  | "cobalt"
  | "gold"
  | "copper"
  | "sodalite"
  | "malachite"
  | "tanzanite"
  | "terracotta";

/**
 * The whole border of a tile takes its mineral, at 60% (a SOLID border on all
 * four sides, never a one-side stripe: Mzizi border rule, see globals.css
 * "Card edge"). Static strings so Tailwind can see every class.
 */
const EDGE_CLASS: Record<Mineral, string> = {
  cobalt: "[&>section]:border-mineral-cobalt/60",
  gold: "[&>section]:border-mineral-gold/60",
  copper: "[&>section]:border-mineral-copper/60",
  sodalite: "[&>section]:border-mineral-sodalite/60",
  malachite: "[&>section]:border-mineral-malachite/60",
  tanzanite: "[&>section]:border-mineral-tanzanite/60",
  terracotta: "[&>section]:border-mineral-terracotta/60",
};

/**
 * Wraps a card so its whole border takes the card's mineral and the card sits
 * slightly raised (`shadow-md`). The card is the wrapper's `<section>` child;
 * it fills the wrapper's height so a row of tiles lines up.
 */
export function EdgeTile({
  mineral,
  className,
  children,
  metric,
  onOpen,
  detailLabel,
  onOpenDetail,
}: {
  mineral: Mineral;
  className?: string;
  children: ReactNode;
  /** When set with `onOpen`, the whole tile opens that metric's detail. */
  metric?: MetricKind;
  onOpen?: (metric: MetricKind) => void;
  /** For a tile that is not a MetricKind (air quality): its label and opener. */
  detailLabel?: string;
  onOpenDetail?: () => void;
}) {
  const open = metric && onOpen ? () => onOpen(metric) : onOpenDetail;
  const label = metric ? `${METRIC_TITLES[metric]} details` : detailLabel;
  const interactive = Boolean(open && label);
  return (
    <div
      className={cn(
        "relative min-w-0 rounded-[var(--radius-card)] [&>section]:h-full [&>section]:shadow-md",
        EDGE_CLASS[mineral],
        interactive && "card-interactive",
        className,
      )}
    >
      {children}
      {open && label && (
        <button
          type="button"
          onClick={open}
          aria-haspopup="dialog"
          aria-label={label}
          className="absolute inset-0 z-[1] rounded-[var(--radius-card)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        />
      )}
    </div>
  );
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export { aqiScalePct } from "@/lib/air-quality-details";

/** One-line comparison with yesterday at the same hour, or null if unknown. */
export function aqiTrendSentence(
  trend: "worse" | "better" | "similar" | null | undefined,
): string | null {
  switch (trend) {
    case "worse":
      return "Worse than yesterday at this time.";
    case "better":
      return "Better than yesterday at this time.";
    case "similar":
      return "About the same as yesterday at this time.";
    default:
      return null;
  }
}

/**
 * Hourly precipitation (mm) for the next 24 slots from the LOCATION's
 * current hour (payload `utc_offset_seconds`; the viewer's clock is only a
 * fallback for payloads that predate it).
 */
export function next24hPrecipSeries(
  hourly: HourlyWeather | undefined,
  now: Date,
  offsetSeconds?: number | null,
): number[] {
  const times = hourly?.time ?? [];
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  const hourStart = currentWallHourMs(offset, now);
  const start = times.findIndex((t) => {
    const k = wallClockMs(t, offset);
    return k !== null && k >= hourStart;
  });
  if (start === -1) return [];
  return (hourly?.precipitation ?? [])
    .slice(start, start + 24)
    .map((v) => (Number.isFinite(v) ? v : 0));
}

/**
 * The LOCATION's calendar date (YYYY-MM-DD) for the normals request. With
 * no offset it falls back to the viewer's calendar day.
 */
export function localIsoDate(now: Date, offsetSeconds?: number | null): string {
  return locationDateString(resolveOffsetSeconds(offsetSeconds, now), now);
}

/** Today's forecast high, or null when the daily series is empty. */
export function todayHighFrom(daily: DailyWeather | undefined): number | null {
  const v = daily?.temperature_2m_max?.[0];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

const EMPTY_HOURLY: HourlyWeather = {
  time: [],
  temperature_2m: [],
  apparent_temperature: [],
  relative_humidity_2m: [],
  precipitation_probability: [],
  precipitation: [],
  weather_code: [],
  visibility: [],
  cloud_cover: [],
  surface_pressure: [],
  wind_speed_10m: [],
  wind_direction_10m: [],
  wind_gusts_10m: [],
  uv_index: [],
  is_day: [],
};

const EMPTY_DAILY: DailyWeather = {
  time: [],
  weather_code: [],
  temperature_2m_max: [],
  temperature_2m_min: [],
  apparent_temperature_max: [],
  apparent_temperature_min: [],
  sunrise: [],
  sunset: [],
  uv_index_max: [],
  precipitation_sum: [],
  precipitation_probability_max: [],
  wind_speed_10m_max: [],
  wind_gusts_10m_max: [],
};

// ── Data hooks ──────────────────────────────────────────────────────────────

interface NormalsPayload {
  available: boolean;
  normalHigh?: number | null;
}

type NormalState =
  | { status: "loading" }
  | { status: "ready"; normalHigh: number | null };

/** ERA5 1991–2020 normal high for today at this place (null if unavailable). */
function useNormalHigh(
  lat: number | undefined,
  lon: number | undefined,
  offsetSeconds?: number,
  /** False until the Conditions grid is near the viewport (deferred fetch). */
  enabled = true,
) {
  const [state, setState] = useState<NormalState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    if (typeof lat !== "number" || typeof lon !== "number") return;
    const controller = new AbortController();
    const date = localIsoDate(new Date(), offsetSeconds);
    fetchWorker(
      "normals",
      `lat=${roundCoord(lat)}&lon=${roundCoord(lon)}&date=${date}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as NormalsPayload;
      })
      .then((json) => {
        setState({
          status: "ready",
          normalHigh:
            json.available && typeof json.normalHigh === "number"
              ? json.normalHigh
              : null,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "ready", normalHigh: null });
        }
      });
    return () => controller.abort();
  }, [lat, lon, offsetSeconds, enabled]);

  return state;
}

type AqPayload = AirQualityResponse & {
  trend?: "worse" | "better" | "similar" | null;
};

type AqState =
  | { status: "loading" }
  | { status: "ready"; data: AqPayload }
  | { status: "error" };

function useAirQuality(lat: number | undefined, lon: number | undefined) {
  const [state, setState] = useState<AqState>({ status: "loading" });

  useEffect(() => {
    if (typeof lat !== "number" || typeof lon !== "number") return;
    const controller = new AbortController();
    fetchWorker(
      "air-quality",
      `lat=${roundCoord(lat)}&lon=${roundCoord(lon)}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as AqPayload;
      })
      .then((json) => setState({ status: "ready", data: json }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [lat, lon]);

  return state;
}

// ── Air quality (wide) ──────────────────────────────────────────────────────

function AirQualityWide({
  lat,
  lon,
  slug,
  now,
}: {
  lat: number;
  lon: number;
  slug?: string;
  now: Date;
}) {
  const state = useAirQuality(lat, lon);
  const [open, setOpen] = useState(false);

  if (state.status === "loading") return <AirQualityWideSkeleton />;

  if (state.status === "error") {
    return (
      <section
        aria-labelledby="air-quality-heading"
        className="acacia mb-[var(--space-stack)] flex min-w-0 flex-col gap-2"
      >
        <h3 id="air-quality-heading" className="hornbill text-sm">
          Air quality
        </h3>
        <p className="dove">Air quality is unavailable right now.</p>
      </section>
    );
  }

  const data = state.data;
  const band = aqiBand(data.aqi);
  const pollutant = data.dominantPollutant
    ? POLLUTANT_LABELS[data.dominantPollutant]
    : null;
  const sentenceParts = [
    `${AQI_BAND_LABELS[band]}${pollutant ? `, mainly ${pollutant}` : ""}.`,
    aqiTrendSentence(data.trend),
  ].filter(Boolean);

  return (
    <EdgeTile
      mineral="terracotta"
      className="mb-[var(--space-stack)]"
      detailLabel="Air quality details"
      onOpenDetail={() => setOpen(true)}
    >
      <section
        aria-labelledby="air-quality-heading"
        className="acacia flex min-w-0 flex-col gap-3"
      >
        <header className="flex items-center gap-1.5">
          <span className="text-text-tertiary" aria-hidden="true">
            <CloudIcon size={16} />
          </span>
          <h3 id="air-quality-heading" className="hornbill text-sm">
            Air quality
          </h3>
        </header>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary">
            {data.aqi}
          </p>
          <p className="giraffe">{AQI_BAND_LABELS[band]}</p>
        </div>
        <GradientScale
          positionPct={aqiScalePct(data.aqi)}
          stops="aqi"
          label={`US AQI ${data.aqi}, ${AQI_BAND_LABELS[band]}`}
        />
        <p className="dove leading-snug">{sentenceParts.join(" ")}</p>
      </section>
      <AirQualityDetail
        open={open}
        reading={data}
        slug={slug}
        now={now}
        onClose={() => setOpen(false)}
      />
    </EdgeTile>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function AtmosphericSummary({
  current,
  weather,
  lat,
  lon,
  afterAirQuality,
}: Props) {
  const pathname = usePathname();
  const locationSlug = pathname?.split("/")[1] || "";
  const data: WeatherData = weather ?? {
    current,
    hourly: EMPTY_HOURLY,
    daily: EMPTY_DAILY,
    current_units: {},
  };
  // Payload time on the server render and the first client render (so the
  // HTML hydrates), the real clock straight after mount.
  const now = useStableNow(
    seedNowMs(data.current?.time, data.utc_offset_seconds),
  );
  const hasCoords = typeof lat === "number" && typeof lon === "number";
  // The climate-normal comparison is a below-the-fold detail on phones:
  // fetch it once the Conditions grid is near the viewport, not on load.
  const sectionRef = useRef<HTMLElement>(null);
  const nearViewport = useNearViewport(sectionRef, "600px");
  const normals = useNormalHigh(
    lat,
    lon,
    data.utc_offset_seconds,
    nearViewport,
  );

  const wind = windInsight(data, now);
  const uv = uvInsight(data, now);
  const feels = feelsLikeInsight(data);
  const rain = precipitationInsight(data, now);
  const rainSeries = next24hPrecipSeries(
    data.hourly,
    now,
    data.utc_offset_seconds,
  );
  const visibility = visibilityInsight(data, now);
  const humidity = humidityInsight(data);
  const pressure = pressureInsight(data, now);
  const sun = sunInsight(data, now);
  const moon = moonPhase(now);
  const todayHigh = todayHighFrom(data.daily);
  const normalHigh = normals.status === "ready" ? normals.normalHigh : null;
  const averages =
    todayHigh !== null
      ? temperatureAverageInsight(todayHigh, normalHigh)
      : null;
  const moonPct = Math.round(moon.illumination * 100);
  const [openMetric, setOpenMetric] = useState<MetricKind | null>(null);
  // The next moonrise, as the place's own clock time. Recomputed at most every
  // ten minutes (the search is a few hundred altitude evaluations).
  const nowBucket = Math.floor(now.getTime() / 600_000);
  const moonrise = useMemo(() => {
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    const at = new Date(nowBucket * 600_000);
    const rise = nextMoonrise(at, lat, lon);
    return moonriseLabel(
      rise ? rise.getTime() : null,
      at.getTime(),
      resolveOffsetSeconds(data.utc_offset_seconds, at),
    );
  }, [nowBucket, lat, lon, data.utc_offset_seconds]);
  const extras = useMemo(
    () => ({
      todayHigh,
      normalHigh,
      moonName: moon.name,
      moonIlluminationPct: moonPct,
      moonrise,
    }),
    [todayHigh, normalHigh, moon.name, moonPct, moonrise],
  );

  return (
    <section ref={sectionRef} aria-labelledby="atmospheric-heading">
      <SectionHeader
        headingId="atmospheric-heading"
        title="Conditions"
        action={{ label: "24h trends →", href: `/${locationSlug}/atmosphere` }}
        className="mb-[var(--space-stack)]"
      />

      {hasCoords && (
        <LazySection label="air-quality" fallback={<AirQualityWideSkeleton />}>
          <ChartErrorBoundary name="air quality">
            <AirQualityWide
              lat={lat}
              lon={lon}
              slug={locationSlug || undefined}
              now={now}
            />
          </ChartErrorBoundary>
        </LazySection>
      )}

      {afterAirQuality}

      {/* Tile order fills the grid: four square tiles (one full row on lg,
          two on mobile), the full-width precipitation tile, then the rest,
          whose last tile spans whatever the final row has left
          (lastTileSpanClass), so no layout ends with an empty slot. */}
      <InsightGrid>
        <EdgeTile mineral="cobalt" metric="wind" onOpen={setOpenMetric}>
          <InsightCard
            headingId="insight-wind"
            icon={<WindIcon size={16} />}
            label="Wind"
            sentence={wind.sentence}
          >
            <CompassDial
              directionDeg={wind.directionDeg}
              speed={wind.speed}
              gust={wind.gust}
            />
          </InsightCard>
        </EdgeTile>

        <EdgeTile mineral="gold" metric="uv" onOpen={setOpenMetric}>
          <InsightCard
            headingId="insight-uv"
            icon={<SunIcon size={16} />}
            label="UV index"
            sentence={uv.sentence}
          >
            <div className="flex w-full flex-col gap-2">
              <ScaleReadout
                value={uv.value}
                label={uv.label}
                positionPct={uv.positionPct}
                preset="uv"
              />
              {uv.peakTime && (
                <p className="dove text-center">Peak {uv.peakTime}</p>
              )}
            </div>
          </InsightCard>
        </EdgeTile>

        <EdgeTile mineral="copper" metric="feels" onOpen={setOpenMetric}>
          <InsightCard
            headingId="insight-feels"
            icon={<ThermometerIcon size={16} />}
            label="Feels like"
            sentence={feels.sentence}
          >
            <p className="font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary">
              {feels.value}°
            </p>
          </InsightCard>
        </EdgeTile>

        <EdgeTile
          mineral="tanzanite"
          metric="visibility"
          onOpen={setOpenMetric}
        >
          <InsightCard
            headingId="insight-visibility"
            icon={<EyeIcon size={16} />}
            label="Visibility"
            sentence={visibility.sentence}
          >
            <div className="flex flex-col items-center gap-1">
              <p className="font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary">
                {visibility.km !== null ? `${visibility.km} km` : "—"}
              </p>
              <p className="dove">{visibility.label}</p>
            </div>
          </InsightCard>
        </EdgeTile>

        <EdgeTile
          mineral="sodalite"
          className="col-span-full"
          metric="rain"
          onOpen={setOpenMetric}
        >
          <InsightCard
            headingId="insight-rain"
            icon={<CloudRainIcon size={16} />}
            label="Precipitation"
            sentence={rain.sentence}
            size="wide"
          >
            <div className="flex w-full flex-col gap-2">
              <p className="font-heading text-center text-2xl font-semibold leading-none tabular-nums text-text-primary">
                {rain.next24hMm} mm
              </p>
              {rainSeries.length > 0 && (
                <MiniBars
                  values={rainSeries}
                  label="Rain next 24 hours"
                  highlightIndex={0}
                />
              )}
            </div>
          </InsightCard>
        </EdgeTile>

        <EdgeTile mineral="malachite" metric="humidity" onOpen={setOpenMetric}>
          <InsightCard
            headingId="insight-humidity"
            icon={<DropletIcon size={16} />}
            label="Humidity"
            sentence={humidity.sentence}
          >
            <div className="flex flex-col items-center gap-1">
              <p className="font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary">
                {humidity.value}%
              </p>
              <p className="dove">Dew point {humidity.dewPoint}°</p>
            </div>
          </InsightCard>
        </EdgeTile>

        <EdgeTile mineral="cobalt" metric="pressure" onOpen={setOpenMetric}>
          <InsightCard
            headingId="insight-pressure"
            icon={<GaugeIcon size={16} />}
            label="Pressure"
            sentence={pressure.sentence}
          >
            <PressureDial hPa={pressure.hPa} trend={pressure.trend} />
          </InsightCard>
        </EdgeTile>

        <EdgeTile mineral="gold" metric="sun" onOpen={setOpenMetric}>
          <InsightCard
            headingId="insight-sun"
            icon={<SunriseIcon size={16} />}
            label="Sun"
            sentence={sun.sentence}
          >
            <SunArc
              arcPct={sun.arcPct}
              sunrise={sun.sunrise ?? "—"}
              sunset={sun.sunset ?? "—"}
            />
          </InsightCard>
        </EdgeTile>

        <EdgeTile
          mineral="tanzanite"
          className={averages ? undefined : lastTileSpanClass(4)}
          metric="moon"
          onOpen={setOpenMetric}
        >
          <InsightCard
            headingId="insight-moon"
            icon={<MoonIcon size={16} />}
            label="Moon"
            sentence={`${moon.name}, ${moonPct}% lit.${moonrise ? ` Moonrise ${moonrise}.` : ""}`}
          >
            <MoonDisc
              phase={moon.phase}
              illumination={moon.illumination}
              southernHemisphere={typeof lat === "number" && lat < 0}
            />
          </InsightCard>
        </EdgeTile>

        {averages && (
          <EdgeTile
            mineral="copper"
            className={lastTileSpanClass(5)}
            metric="averages"
            onOpen={setOpenMetric}
          >
            <InsightCard
              headingId="insight-averages"
              icon={<ThermometerIcon size={16} />}
              label="Averages"
              sentence={averages.sentence}
            >
              <div className="flex flex-col items-center gap-1">
                <p className="font-heading text-4xl font-semibold leading-none tabular-nums text-text-primary">
                  {todayHigh}°
                </p>
                <p className="dove">
                  {normalHigh !== null
                    ? `Normal high ${Math.round(normalHigh)}°`
                    : "Today's high"}
                </p>
              </div>
            </InsightCard>
          </EdgeTile>
        )}
      </InsightGrid>

      <MetricDetailModal
        kind={openMetric}
        data={data}
        now={now}
        extras={extras}
        lat={lat}
        lon={lon}
        slug={locationSlug || undefined}
        onClose={() => setOpenMetric(null)}
      />
    </section>
  );
}
