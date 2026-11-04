import { WeatherIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, uvLevel, type DailyWeather } from "@/lib/weather";
import { TEMP_ANCHORS } from "@/lib/weather-scales";
import { blendGradientCss, trackWindow, valueStops } from "@/lib/scale-blend";
import { DailyChart } from "./DailyChart";

interface Props {
  daily: DailyWeather;
}

/** Calculate the percentage position of a temperature within the overall range */
export function tempPercent(temp: number, absMin: number, absMax: number) {
  const range = absMax - absMin;
  if (range === 0) return 50;
  return ((temp - absMin) / range) * 100;
}

/**
 * The temperature gradient of the whole week's track (absMin at the left end,
 * absMax at the right end). It BLENDS through the temperature scale
 * (weather-scales.ts, `--wx-temp-*`, cold blue to hot red) with each colour
 * unmixed at the middle of its band, so a given temperature has the same colour
 * on every row of the week; each day's pill is a window onto this one gradient
 * (see `trackWindow`), not a gradient of its own.
 */
export function tempTrackGradient(absMin: number, absMax: number) {
  const span = Math.max(absMax - absMin, 1);
  return blendGradientCss(
    valueStops(TEMP_ANCHORS, (t) => ((t - absMin) / span) * 100),
  );
}

export function DailyForecast({ daily }: Props) {
  // Calculate the absolute temp range across all 7 days for consistent bar scaling
  const allHighs = daily.temperature_2m_max.map(Math.round);
  const allLows = daily.temperature_2m_min.map(Math.round);
  const absMin = Math.min(...allLows);
  const absMax = Math.max(...allHighs);
  const trackGradient = tempTrackGradient(absMin, absMax);

  return (
    <section aria-labelledby="daily-forecast-heading">
      <div className="baobab">
        <h2 id="daily-forecast-heading" className="giraffe">
          {daily.time.length}-Day Forecast
        </h2>
        <DailyChart daily={daily} />
        <div
          className="stagger-children mt-3 space-y-1.5"
          role="list"
          aria-label="7-day weather forecast"
        >
          {daily.time.map((date, i) => {
            // Daily dates are the LOCATION's calendar days ("YYYY-MM-DD").
            // Read them as a UTC calendar date so a viewer west of UTC never
            // sees "2026-10-08" as Wednesday the 7th.
            const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
            const info = weatherCodeToInfo(daily.weather_code[i]);
            const isToday = i === 0;
            const dayName = isToday
              ? "Today"
              : d.toLocaleDateString("en-ZW", {
                  weekday: "short",
                  timeZone: "UTC",
                });
            const dateNum = d.getUTCDate();
            const high = Math.round(daily.temperature_2m_max[i]);
            const low = Math.round(daily.temperature_2m_min[i]);
            const feelsHigh = Math.round(daily.apparent_temperature_max[i]);
            const feelsLow = Math.round(daily.apparent_temperature_min[i]);

            const lowPct = tempPercent(low, absMin, absMax);
            const highPct = tempPercent(high, absMin, absMax);
            const win = trackWindow(lowPct, highPct, 4);
            const rainPct = daily.precipitation_probability_max[i];
            const precipMm = daily.precipitation_sum[i];
            const windMax = Math.round(daily.wind_speed_10m_max[i]);
            const gustMax = Math.round(daily.wind_gusts_10m_max[i]);
            const uvMax = daily.uv_index_max[i];
            const uvInfo = uvLevel(uvMax);

            return (
              <div
                key={date}
                role="listitem"
                aria-label={`${dayName} ${dateNum}: ${info.label}, high ${high} degrees, low ${low} degrees`}
                className="rounded-[var(--radius-input)] bg-surface-base px-3 py-2.5 min-h-[var(--touch-target-min)] transition-colors hover:bg-surface-elevated"
              >
                {/* Main row: day, icon, temps, bar */}
                <div className="flex items-center gap-2 sm:gap-3">
                  {/* Day + date */}
                  <div className="flex w-10 shrink-0 flex-col items-center sm:w-12">
                    <span className="text-base font-medium text-text-secondary leading-tight">
                      {dayName}
                    </span>
                    <span className="text-lg font-bold text-text-primary leading-tight">
                      {dateNum}
                    </span>
                  </div>

                  {/* Icon + rain */}
                  <div className="flex w-8 shrink-0 flex-col items-center gap-0.5">
                    <WeatherIcon
                      icon={info.icon}
                      size={18}
                      className="text-primary"
                    />
                    {rainPct > 0 && (
                      <span className="text-base font-semibold text-rain">
                        {rainPct}%
                      </span>
                    )}
                  </div>

                  {/* Low temp */}
                  <span
                    className="w-8 shrink-0 text-right text-base text-text-tertiary"
                    aria-label={`Low ${low} degrees`}
                  >
                    {low}°
                  </span>

                  {/* Temperature range bar: the week's track, with this day's
                      low-to-high pill as a window onto its blended gradient */}
                  <div
                    className="relative mx-1 h-2 flex-1 rounded-full bg-temp-bar-track"
                    aria-hidden="true"
                  >
                    <div
                      className="absolute inset-y-0 overflow-hidden rounded-full ring-1 ring-wx-outline"
                      style={{ left: `${win.left}%`, width: `${win.width}%` }}
                    >
                      <div
                        className="absolute inset-y-0"
                        style={{
                          left: `${win.innerLeft}%`,
                          width: `${win.innerWidth}%`,
                          backgroundImage: trackGradient,
                        }}
                      />
                    </div>
                  </div>

                  {/* High temp */}
                  <span
                    className="w-8 shrink-0 text-base font-semibold text-text-primary"
                    aria-label={`High ${high} degrees`}
                  >
                    {high}°
                  </span>
                </div>

                {/* Detail row: feels-like, precipitation, wind, UV */}
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 pl-[46px] text-base text-text-tertiary sm:pl-[52px]">
                  <span>
                    Feels {feelsLow}°/{feelsHigh}°
                  </span>
                  {precipMm > 0 && <span>{precipMm.toFixed(1)} mm</span>}
                  <span>Wind {windMax} km/h</span>
                  {gustMax > windMax && <span>Gusts {gustMax}</span>}
                  {/* A provider can have no UV maximum for a day (the
                      failover forecast has none past its hourly steps): say
                      nothing rather than "UV  Low". */}
                  {uvMax != null && (
                    <span className="inline-flex items-center gap-1">
                      <span
                        aria-hidden="true"
                        className={`size-2.5 rounded-full ring-1 ring-wx-outline ${uvInfo.swatch}`}
                      />
                      UV {uvMax} {uvInfo.label}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
