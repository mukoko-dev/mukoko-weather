import { WeatherIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, type DailyWeather } from "@/lib/weather";

interface Props {
  daily: DailyWeather;
}

export function DailyForecast({ daily }: Props) {
  return (
    <section aria-labelledby="daily-forecast-heading">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-6 shadow-sm">
        <h2 id="daily-forecast-heading" className="text-lg font-semibold text-text-primary font-sans">7-Day Forecast</h2>
        <div className="mt-4 divide-y divide-text-tertiary/10" role="list" aria-label="7-day weather forecast">
          {daily.time.map((date, i) => {
            const d = new Date(date);
            const info = weatherCodeToInfo(daily.weather_code[i]);
            const isToday = i === 0;
            const dayName = isToday
              ? "Today"
              : d.toLocaleDateString("en-ZW", { weekday: "short" });
            const high = Math.round(daily.temperature_2m_max[i]);
            const low = Math.round(daily.temperature_2m_min[i]);

            return (
              <div
                key={date}
                role="listitem"
                aria-label={`${dayName}: ${info.label}, high ${high} degrees, low ${low} degrees`}
                className="flex items-center gap-4 py-3"
              >
                <span className="w-12 text-sm font-medium text-text-secondary">
                  {dayName}
                </span>
                <WeatherIcon icon={info.icon} size={24} className="text-primary" />
                <span className="flex-1 text-sm text-text-secondary">{info.label}</span>
                {daily.precipitation_probability_max[i] > 0 && (
                  <span className="text-xs text-secondary">
                    {daily.precipitation_probability_max[i]}%
                  </span>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold text-text-primary" aria-label={`High ${high} degrees`}>
                    {high}°
                  </span>
                  <span className="text-text-tertiary" aria-label={`Low ${low} degrees`}>
                    {low}°
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
