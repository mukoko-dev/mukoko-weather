/**
 * Detail view for every Conditions tile (Apple Weather opens a full card when
 * a tile is tapped; ours opens `MetricDetailModal`). Pure functions over
 * WeatherData: the next 24 hours as a chart series, the stats a person wants
 * next to it, and one plain sentence on what the number means. No network and
 * no AI call, and nothing here reads the viewer's clock or time zone.
 */

import type { WeatherData, HourlyWeather } from "./weather";
import { windDirection } from "./weather";
import { dewPointFromTempHumidity } from "./activity-feasibility";
import { currentHourIndex, locationClockLabel } from "./location-time";
import {
  feelsLikeInsight,
  humidityInsight,
  precipitationInsight,
  pressureInsight,
  sunInsight,
  uvInsight,
  visibilityInsight,
  windInsight,
} from "./metric-insights";

export const METRIC_KINDS = [
  "wind",
  "uv",
  "feels",
  "visibility",
  "rain",
  "humidity",
  "pressure",
  "sun",
  "moon",
  "averages",
] as const;

export type MetricKind = (typeof METRIC_KINDS)[number];

/** Which chart the modal draws for a metric (null = stats only). */
export type MetricChart =
  | "wind"
  | "uv"
  | "feels"
  | "visibility"
  | "rain"
  | "humidity"
  | "pressure"
  | null;

export const METRIC_CHART: Record<MetricKind, MetricChart> = {
  wind: "wind",
  uv: "uv",
  feels: "feels",
  visibility: "visibility",
  rain: "rain",
  humidity: "humidity",
  pressure: "pressure",
  sun: null,
  moon: null,
  averages: null,
};

export const METRIC_TITLES: Record<MetricKind, string> = {
  wind: "Wind",
  uv: "UV index",
  feels: "Feels like",
  visibility: "Visibility",
  rain: "Precipitation",
  humidity: "Humidity",
  pressure: "Pressure",
  sun: "Sun",
  moon: "Moon",
  averages: "Averages",
};

export function isMetricKind(value: unknown): value is MetricKind {
  return (
    typeof value === "string" &&
    (METRIC_KINDS as readonly string[]).includes(value)
  );
}

export type MetricSeriesPoint = {
  label: string;
  windSpeed: number;
  windGusts: number;
  uvIndex: number;
  temperature: number;
  feelsLike: number;
  visibility: number;
  precipitation: number;
  rainProbability: number;
  humidity: number;
  dewPoint: number;
  pressure: number;
};

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Up to 24 hourly points starting at the LOCATION's current hour. */
export function metricSeries(
  hourly: HourlyWeather | undefined,
  offsetSeconds: number,
  now: Date,
): MetricSeriesPoint[] {
  if (!hourly?.time?.length) return [];
  const start = currentHourIndex(hourly.time, offsetSeconds, now);
  const points: MetricSeriesPoint[] = [];
  for (let i = 0; i < 24 && start + i < hourly.time.length; i++) {
    const idx = start + i;
    const temp = num(hourly.temperature_2m?.[idx]);
    const rh = num(hourly.relative_humidity_2m?.[idx], 50);
    const dew = hourly.dew_point_2m?.[idx];
    points.push({
      label:
        i === 0 ? "Now" : locationClockLabel(hourly.time[idx], offsetSeconds),
      windSpeed: Math.round(num(hourly.wind_speed_10m?.[idx])),
      windGusts: Math.round(num(hourly.wind_gusts_10m?.[idx])),
      uvIndex: Math.round(num(hourly.uv_index?.[idx]) * 10) / 10,
      temperature: Math.round(temp),
      feelsLike: Math.round(num(hourly.apparent_temperature?.[idx], temp)),
      // Open-Meteo reports visibility in metres; the card speaks kilometres.
      visibility: Math.round((num(hourly.visibility?.[idx]) / 1000) * 10) / 10,
      precipitation: Math.round(num(hourly.precipitation?.[idx]) * 10) / 10,
      rainProbability: Math.round(num(hourly.precipitation_probability?.[idx])),
      humidity: Math.round(rh),
      dewPoint: Math.round(
        typeof dew === "number" && Number.isFinite(dew)
          ? dew
          : dewPointFromTempHumidity(temp, rh),
      ),
      pressure: Math.round(num(hourly.surface_pressure?.[idx])),
    });
  }
  return points;
}

export interface MetricStat {
  label: string;
  value: string;
}

export interface MetricDetail {
  kind: MetricKind;
  title: string;
  /** The big number or phrase at the top of the modal. */
  headline: string;
  /** The same one-line insight the tile shows. */
  sentence: string;
  stats: MetricStat[];
  /** What the metric is, in one or two plain sentences. */
  about: string;
}

export interface MetricExtras {
  /** Today's forecast high, °C. */
  todayHigh?: number | null;
  /** Climate-normal high for today, °C. */
  normalHigh?: number | null;
  moonName?: string;
  moonIlluminationPct?: number;
}

const ABOUT: Record<MetricKind, string> = {
  wind: "Wind is air moving across the ground. Gusts are the short peaks above the steady speed, and they are what moves branches, kites and loads on a truck.",
  uv: "The UV index rates how fast unprotected skin burns. From 3 upwards, shade, a hat and sunscreen matter. It is highest around midday and falls to zero at night.",
  feels:
    "Feels like blends the air temperature with humidity and wind to show what your body reads. Humid air feels warmer, wind on a cool day feels colder.",
  visibility:
    "Visibility is how far you can see a dark object against the sky. Haze, smoke, dust, mist and rain all shorten it, which matters for driving and flying.",
  rain: "Precipitation is the rain that has fallen or is forecast, in millimetres. One millimetre is a litre on every square metre of ground.",
  humidity:
    "Relative humidity is how full the air is with water vapour. The dew point is the temperature at which that vapour turns to dew: above 20 degrees the air feels muggy.",
  pressure:
    "Air pressure at the surface. A steady fall often comes before wind and rain, a steady rise before fair weather.",
  sun: "Sunrise and sunset in the place's own time zone, and how long the day is. The dotted line shows where the sun is on its arc now.",
  moon: "The moon phase and how much of its face is lit. The phase is the same everywhere on Earth, but it looks mirrored in the southern hemisphere.",
  averages:
    "Today's forecast high against the 1991-2020 average high for this date at this place, so a hot or cool day reads in context.",
};

const dash = "-";
const deg = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)}°` : dash;

export function metricDetail(
  kind: MetricKind,
  data: WeatherData,
  now: Date,
  extras: MetricExtras = {},
): MetricDetail {
  const base = { kind, title: METRIC_TITLES[kind], about: ABOUT[kind] };
  switch (kind) {
    case "wind": {
      const w = windInsight(data, now);
      return {
        ...base,
        headline: `${w.speed} km/h ${w.directionLabel}`,
        sentence: w.sentence,
        stats: [
          { label: "Gusts", value: `${w.gust} km/h` },
          {
            label: "Direction",
            value: `${w.directionLabel} (${Math.round(w.directionDeg)}°)`,
          },
          { label: "Beaufort", value: w.beaufortLabel },
        ],
      };
    }
    case "uv": {
      const u = uvInsight(data, now);
      return {
        ...base,
        headline: `${u.value} ${u.label}`,
        sentence: u.sentence,
        stats: [
          {
            label: "Peak today",
            value: `${u.peakToday}${u.peakTime ? ` at ${u.peakTime}` : ""}`,
          },
          { label: "Protect from", value: u.protectFrom ?? dash },
          { label: "Protect until", value: u.protectUntil ?? dash },
        ],
      };
    }
    case "feels": {
      const f = feelsLikeInsight(data);
      const c = data.current;
      return {
        ...base,
        headline: `${f.value}°`,
        sentence: f.sentence,
        stats: [
          { label: "Actual", value: deg(c?.temperature_2m) },
          {
            label: "Difference",
            value: `${f.delta > 0 ? "+" : ""}${f.delta}°`,
          },
          {
            label: "Humidity",
            value: `${Math.round(num(c?.relative_humidity_2m))}%`,
          },
          {
            label: "Wind",
            value: `${Math.round(num(c?.wind_speed_10m))} km/h`,
          },
        ],
      };
    }
    case "visibility": {
      const v = visibilityInsight(data, now);
      return {
        ...base,
        headline: v.km !== null ? `${v.km} km` : dash,
        sentence: v.sentence,
        stats: [{ label: "Conditions", value: v.label }],
      };
    }
    case "rain": {
      const r = precipitationInsight(data, now);
      return {
        ...base,
        headline: `${r.next24hMm} mm`,
        sentence: r.sentence,
        stats: [
          { label: "Next 24 h", value: `${r.next24hMm} mm` },
          { label: "Last 24 h", value: `${r.last24hMm} mm` },
          {
            label: "Rain next",
            value: r.nextRainTime ?? r.nextRainDay ?? "None expected",
          },
        ],
      };
    }
    case "humidity": {
      const h = humidityInsight(data);
      return {
        ...base,
        headline: `${h.value}%`,
        sentence: h.sentence,
        stats: [
          { label: "Dew point", value: `${h.dewPoint}°` },
          {
            label: "Air temperature",
            value: deg(data.current?.temperature_2m),
          },
        ],
      };
    }
    case "pressure": {
      const p = pressureInsight(data, now);
      return {
        ...base,
        headline: `${p.hPa} hPa`,
        sentence: p.sentence,
        stats: [
          {
            label: "Trend",
            value: p.trend[0].toUpperCase() + p.trend.slice(1),
          },
        ],
      };
    }
    case "sun": {
      const s = sunInsight(data, now);
      return {
        ...base,
        headline: s.nextEventTime
          ? `${s.nextEventLabel} ${s.nextEventTime}`
          : dash,
        sentence: s.sentence,
        stats: [
          { label: "Sunrise", value: s.sunrise ?? dash },
          { label: "Sunset", value: s.sunset ?? dash },
          { label: "Daylight", value: `${s.daylightHours} h` },
        ],
      };
    }
    case "moon":
      return {
        ...base,
        headline: extras.moonName ?? dash,
        sentence:
          extras.moonName && typeof extras.moonIlluminationPct === "number"
            ? `${extras.moonName}, ${extras.moonIlluminationPct}% lit.`
            : "Moon data unavailable.",
        stats: [
          { label: "Phase", value: extras.moonName ?? dash },
          {
            label: "Lit",
            value:
              typeof extras.moonIlluminationPct === "number"
                ? `${extras.moonIlluminationPct}%`
                : dash,
          },
        ],
      };
    case "averages": {
      const high = extras.todayHigh;
      const normal = extras.normalHigh;
      const hasBoth = typeof high === "number" && typeof normal === "number";
      const delta = hasBoth ? Math.round(high - normal) : null;
      return {
        ...base,
        headline: deg(high),
        sentence:
          delta === null
            ? "No climate average is available for this place yet."
            : delta === 0
              ? "Right at the average daily high."
              : `${Math.abs(delta)}° ${delta > 0 ? "above" : "below"} the average daily high.`,
        stats: [
          { label: "Today's high", value: deg(high) },
          { label: "Normal high", value: deg(normal) },
          {
            label: "Difference",
            value: delta === null ? dash : `${delta > 0 ? "+" : ""}${delta}°`,
          },
        ],
      };
    }
  }
}

/** Compass label helper re-exported so the modal needs one import. */
export { windDirection };
