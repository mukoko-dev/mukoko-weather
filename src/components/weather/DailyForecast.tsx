import { WeatherIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, uvLevel, type DailyWeather } from "@/lib/weather";
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

/** Get the warm gradient color for a temperature position (0-100%) */
export function tempBarGradient(lowPct: number, highPct: number) {
  return `linear-gradient(to right, var(--color-temp-cool) ${lowPct}%, var(--color-temp-mild) ${(lowPct + highPct) / 2}%, var(--color-temp-warm) ${highPct}%)`;
}

export function DailyForecast({ daily }: Props) {
  // Calculate the absolute temp range across all 7 days for consistent bar scaling
  const allHighs = daily.temperature_2m_max.map(Math.round);
  const allLows = daily.temperature_2m_min.map(Math.round);
  const absMin = Math.min(...allLows);
  const absMax = Math.max(...allHighs);

  return (
    <section aria-labelledby="daily-forecast-heading">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <h2 id="daily-forecast-heading" className="text-lg font-semibold text-text-primary font-heading">{daily.time.length}-Day Forecast</h2>
        <DailyChart daily={daily} />
        <div className="mt-4 space-y-1" role="list" aria-label="7-day weather forecast">
          {daily.time.map((date, i) => {
            const d = new Date(date);
            const info = weatherCodeToInfo(daily.weather_code[i]);
            const isToday = i === 0;
            const dayName = isToday
              ? "Today"
              : d.toLocaleDateString("en-ZW", { weekday: "short" });
            const dateNum = d.getDate();
            const high = Math.round(daily.temperature_2m_max[i]);
            const low = Math.round(daily.temperature_2m_min[i]);
            const feelsHigh = Math.round(daily.apparent_temperature_max[i]);
            const feelsLow = Math.round(daily.apparent_temperature_min[i]);

            const lowPct = tempPercent(low, absMin, absMax);
            const highPct = tempPercent(high, absMin, absMax);
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
                className="rounded-[var(--radius-input)] bg-surface-base px-3 py-2.5 sm:px-4 sm:py-3"
              >
                {/* Main row: day, icon, temps, bar */}
                <div className="flex items-center gap-2 sm:gap-3">
                  {/* Day + date */}
                  <div className="flex w-12 shrink-0 flex-col items-center sm:w-14">
                    <span className="text-sm font-medium text-text-secondary leading-tight">
                      {dayName}
                    </span>
                    <span className="text-lg font-bold text-text-primary leading-tight">
                      {dateNum}
                    </span>
                  </div>

                  {/* Icon + rain */}
                  <div className="flex w-10 shrink-0 flex-col items-center gap-0.5">
                    <WeatherIcon icon={info.icon} size={22} className="text-primary" />
                    {rainPct > 0 && (
                      <span className="text-xs font-semibold text-rain">
                        {rainPct}%
                      </span>
                    )}
                  </div>

                  {/* Low temp */}
                  <span className="w-8 shrink-0 text-right text-sm text-text-tertiary" aria-label={`Low ${low} degrees`}>
                    {low}°
                  </span>

                  {/* Temperature range bar */}
                  <div className="relative mx-1 h-2 flex-1 overflow-hidden rounded-full bg-temp-bar-track" aria-hidden="true">
                    <div
                      className="absolute top-0 h-full rounded-full"
                      style={{
                        left: `${lowPct}%`,
                        width: `${Math.max(highPct - lowPct, 4)}%`,
                        background: tempBarGradient(lowPct, highPct),
                      }}
                    />
                  </div>

                  {/* High temp */}
                  <span className="w-8 shrink-0 text-sm font-semibold text-text-primary" aria-label={`High ${high} degrees`}>
                    {high}°
                  </span>
                </div>

                {/* Detail row: feels-like, precipitation, wind, UV */}
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 pl-12 text-xs text-text-tertiary sm:pl-14">
                  <span>Feels {feelsLow}°/{feelsHigh}°</span>
                  {precipMm > 0 && <span>{precipMm.toFixed(1)} mm</span>}
                  <span>Wind {windMax} km/h</span>
                  {gustMax > windMax && <span>Gusts {gustMax}</span>}
                  <span className={uvInfo.color}>UV {uvMax}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
