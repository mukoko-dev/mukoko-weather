import { SunriseIcon, SunsetIcon, SunIcon } from "@/lib/weather-icons";
import type { DailyWeather } from "@/lib/weather";

interface Props {
  daily: DailyWeather;
}

export function SunTimes({ daily }: Props) {
  console.log("[SunTimes] render");
  const sunrise = new Date(daily.sunrise[0]);
  const sunset = new Date(daily.sunset[0]);
  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-ZW", { hour: "2-digit", minute: "2-digit", hour12: false });

  const daylightMs = sunset.getTime() - sunrise.getTime();
  const daylightHours = Math.floor(daylightMs / (1000 * 60 * 60));
  const daylightMinutes = Math.round((daylightMs % (1000 * 60 * 60)) / (1000 * 60));

  return (
    <section aria-labelledby="sun-times-heading">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <h2 id="sun-times-heading" className="text-lg font-semibold text-text-primary font-heading">Sun</h2>
        <div className="mt-4 flex flex-wrap gap-6">
          <div className="flex items-center gap-3">
            <SunriseIcon size={24} className="text-warmth" aria-hidden="true" />
            <div>
              <p className="text-sm text-text-tertiary">Sunrise</p>
              <p className="text-sm font-semibold text-text-primary" aria-label={`Sunrise at ${fmt(sunrise)}`}>{fmt(sunrise)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SunsetIcon size={24} className="text-accent" aria-hidden="true" />
            <div>
              <p className="text-sm text-text-tertiary">Sunset</p>
              <p className="text-sm font-semibold text-text-primary" aria-label={`Sunset at ${fmt(sunset)}`}>{fmt(sunset)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SunIcon size={24} className="text-warmth" aria-hidden="true" />
            <div>
              <p className="text-sm text-text-tertiary">Daylight</p>
              <p className="text-sm font-semibold text-text-primary" aria-label={`${daylightHours} hours and ${daylightMinutes} minutes of daylight`}>{daylightHours}h {daylightMinutes}m</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
