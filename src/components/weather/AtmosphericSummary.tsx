"use client";

import { useEffect, useState, type ReactNode } from "react";
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
import { AQI_BAND_LABELS, aqiBand } from "@/lib/aq-grid";
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

const EDGE_CLASS: Record<Mineral, string> = {
  cobalt: "bg-mineral-cobalt",
  gold: "bg-mineral-gold",
  copper: "bg-mineral-copper",
  sodalite: "bg-mineral-sodalite",
  malachite: "bg-mineral-malachite",
  tanzanite: "bg-mineral-tanzanite",
  terracotta: "bg-mineral-terracotta",
};

/** Wraps a card with the mineral leading edge (a 4px rule, not glass). */
function EdgeTile({
  mineral,
  className,
  children,
}: {
  mineral: Mineral;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative min-w-0 overflow-hidden rounded-[var(--radius-card)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 z-[1] w-1",
          EDGE_CLASS[mineral],
        )}
      />
      {children}
    </div>
  );
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Position on the AQI scale bar, 0–100. Each EPA band occupies an equal
 * sixth of the bar so the colour ramp and the band edges line up by eye.
 */
export function aqiScalePct(aqi: number): number {
  const v = Math.max(0, Math.min(500, aqi));
  const edges = [0, 50, 100, 150, 200, 300, 500];
  for (let i = 1; i < edges.length; i++) {
    if (v <= edges[i]) {
      const lo = edges[i - 1];
      const hi = edges[i];
      const within = (v - lo) / (hi - lo);
      return ((i - 1 + within) / (edges.length - 1)) * 100;
    }
  }
  return 100;
}

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
) {
  const [state, setState] = useState<NormalState>({ status: "loading" });

  useEffect(() => {
    if (typeof lat !== "number" || typeof lon !== "number") return;
    const controller = new AbortController();
    const date = localIsoDate(new Date(), offsetSeconds);
    fetch(`/api/py/normals?lat=${lat}&lon=${lon}&date=${date}`, {
      signal: controller.signal,
    })
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
  }, [lat, lon, offsetSeconds]);

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
    fetch(`/api/py/airquality?lat=${lat}&lon=${lon}`, {
      signal: controller.signal,
    })
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

function AirQualityWide({ lat, lon }: { lat: number; lon: number }) {
  const state = useAirQuality(lat, lon);

  if (state.status === "loading") return <AirQualityWideSkeleton />;

  if (state.status === "error") {
    return (
      <section
        aria-labelledby="air-quality-heading"
        className="acacia flex min-w-0 flex-col gap-2 p-4"
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
    <EdgeTile mineral="terracotta" className="mb-2.5 sm:mb-3">
      <section
        aria-labelledby="air-quality-heading"
        className="acacia flex min-w-0 flex-col gap-3 p-4"
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
  const now = new Date();
  const hasCoords = typeof lat === "number" && typeof lon === "number";
  const normals = useNormalHigh(lat, lon, data.utc_offset_seconds);

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

  return (
    <section aria-labelledby="atmospheric-heading">
      <SectionHeader
        headingId="atmospheric-heading"
        title="Conditions"
        action={{ label: "24h trends →", href: `/${locationSlug}/atmosphere` }}
        className="mb-3"
      />

      {hasCoords && (
        <LazySection label="air-quality" fallback={<AirQualityWideSkeleton />}>
          <ChartErrorBoundary name="air quality">
            <AirQualityWide lat={lat} lon={lon} />
          </ChartErrorBoundary>
        </LazySection>
      )}

      {afterAirQuality}

      <InsightGrid>
        <EdgeTile mineral="cobalt">
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

        <EdgeTile mineral="gold">
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

        <EdgeTile mineral="copper">
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

        <EdgeTile mineral="sodalite" className="col-span-full">
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

        <EdgeTile mineral="tanzanite">
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

        <EdgeTile mineral="malachite">
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

        <EdgeTile mineral="cobalt">
          <InsightCard
            headingId="insight-pressure"
            icon={<GaugeIcon size={16} />}
            label="Pressure"
            sentence={pressure.sentence}
          >
            <PressureDial hPa={pressure.hPa} trend={pressure.trend} />
          </InsightCard>
        </EdgeTile>

        <EdgeTile mineral="gold">
          <InsightCard
            headingId="insight-sun"
            icon={<SunriseIcon size={16} />}
            label="Sun"
            sentence={sun.sentence}
          >
            <div className="flex w-full flex-col gap-1">
              <SunArc
                arcPct={sun.arcPct}
                sunrise={sun.sunrise ?? "—"}
                sunset={sun.sunset ?? "—"}
              />
              <p className="dove flex justify-between">
                <span>{sun.sunrise ?? "—"}</span>
                <span>{sun.sunset ?? "—"}</span>
              </p>
            </div>
          </InsightCard>
        </EdgeTile>

        <EdgeTile mineral="tanzanite">
          <InsightCard
            headingId="insight-moon"
            icon={<MoonIcon size={16} />}
            label="Moon"
            sentence={`${moon.name}, ${moonPct}% lit.`}
          >
            <MoonDisc
              phase={moon.phase}
              illumination={moon.illumination}
              southernHemisphere={typeof lat === "number" && lat < 0}
            />
          </InsightCard>
        </EdgeTile>

        {averages && (
          <EdgeTile mineral="copper">
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
    </section>
  );
}
