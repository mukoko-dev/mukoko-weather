import { WeatherIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, type HourlyWeather } from "@/lib/weather";
import { HourlyChart } from "./HourlyChart";

interface Props {
  hourly: HourlyWeather;
}

export function HourlyForecast({ hourly }: Props) {
  // Show the next 24 hours
  const now = new Date();
  const currentHour = now.getHours();
  // Find the index closest to the current hour
  const startIndex = hourly.time.findIndex((t) => new Date(t).getHours() >= currentHour && new Date(t).getDate() === now.getDate());
  const start = startIndex >= 0 ? startIndex : 0;
  const hours = hourly.time.slice(start, start + 24);

  return (
    <section aria-labelledby="hourly-forecast-heading">
      <div className="overflow-hidden rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <h2 id="hourly-forecast-heading" className="text-lg font-semibold text-text-primary font-heading">24-Hour Forecast</h2>
        <HourlyChart hourly={hourly} />
        <div className="mt-4 flex gap-3 overflow-x-auto pb-2 scrollbar-hide sm:gap-4" role="list" aria-label="Hourly weather forecast">
          {hours.map((time, i) => {
            const idx = start + i;
            const date = new Date(time);
            const info = weatherCodeToInfo(hourly.weather_code[idx]);
            const isDay = hourly.is_day[idx];
            const temp = Math.round(hourly.temperature_2m[idx]);
            const timeLabel = i === 0 ? "Now" : date.toLocaleTimeString("en-ZW", { hour: "2-digit", minute: "2-digit", hour12: false });
            return (
              <div
                key={time}
                role="listitem"
                aria-label={`${timeLabel}: ${temp} degrees, ${info.label}`}
                className="flex min-w-[72px] flex-col items-center gap-2 rounded-[var(--radius-input)] bg-surface-base px-3 py-3"
              >
                <span className="text-xs font-medium text-text-secondary">
                  {timeLabel}
                </span>
                <WeatherIcon
                  icon={isDay ? info.icon : "moon"}
                  size={24}
                  className="text-primary"
                />
                <span className="text-sm font-semibold text-text-primary">
                  {temp}°
                </span>
                {hourly.precipitation_probability[idx] > 0 && (
                  <span className="text-xs font-semibold text-rain">
                    {hourly.precipitation_probability[idx]}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
