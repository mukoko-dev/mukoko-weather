import { WeatherIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, type HourlyWeather } from "@/lib/weather";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface Props {
  hourly: HourlyWeather;
}

/**
 * Horizontal scrollable hour-by-hour weather cards.
 * Renders eagerly above CurrentConditions on the location page.
 */
export function HourlyScrollCards({ hourly }: Props) {
  const now = new Date();
  const currentHour = now.getHours();
  const startIndex = hourly.time.findIndex((t) => new Date(t).getHours() >= currentHour && new Date(t).getDate() === now.getDate());
  const start = startIndex >= 0 ? startIndex : 0;
  const hours = hourly.time.slice(start, start + 24);

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-4 shadow-sm sm:p-5">
      <ScrollArea className="w-full" type="hover">
        <div className="flex gap-4 pb-2 sm:gap-5 [overscroll-behavior-x:contain]" role="list" aria-label="Hourly weather forecast">
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
                className="flex min-w-[72px] flex-col items-center gap-2.5 rounded-[var(--radius-input)] bg-surface-base px-3.5 py-3.5 transition-colors hover:bg-surface-elevated"
              >
                <span className="text-base font-medium text-text-secondary">
                  {timeLabel}
                </span>
                <WeatherIcon
                  icon={isDay ? info.icon : "moon"}
                  size={24}
                  className="text-primary"
                />
                <span className="text-base font-semibold text-text-primary">
                  {temp}°
                </span>
                {(hourly.precipitation_probability?.[idx] ?? 0) > 0 && (
                  <span className="text-base font-semibold text-rain">
                    {hourly.precipitation_probability[idx]}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
