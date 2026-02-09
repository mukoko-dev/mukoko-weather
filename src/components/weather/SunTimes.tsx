import { SunriseIcon, SunsetIcon } from "@/lib/weather-icons";
import type { DailyWeather } from "@/lib/weather";

interface Props {
  daily: DailyWeather;
}

export function SunTimes({ daily }: Props) {
  const sunrise = new Date(daily.sunrise[0]);
  const sunset = new Date(daily.sunset[0]);
  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-ZW", { hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <section aria-labelledby="sun-times-heading">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-6 shadow-sm">
        <h2 id="sun-times-heading" className="text-lg font-semibold text-text-primary font-sans">Sun</h2>
        <div className="mt-4 flex gap-6">
          <div className="flex items-center gap-3">
            <SunriseIcon size={24} className="text-warmth" aria-hidden="true" />
            <div>
              <p className="text-xs text-text-tertiary">Sunrise</p>
              <p className="text-sm font-semibold text-text-primary" aria-label={`Sunrise at ${fmt(sunrise)}`}>{fmt(sunrise)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SunsetIcon size={24} className="text-accent" aria-hidden="true" />
            <div>
              <p className="text-xs text-text-tertiary">Sunset</p>
              <p className="text-sm font-semibold text-text-primary" aria-label={`Sunset at ${fmt(sunset)}`}>{fmt(sunset)}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
