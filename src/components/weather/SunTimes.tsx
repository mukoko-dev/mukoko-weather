import { SunriseIcon, SunsetIcon, SunIcon } from "@/lib/weather-icons";
import type { DailyWeather } from "@/lib/weather";

interface Props {
  daily: DailyWeather;
}

export function SunTimes({ daily }: Props) {
  const sunriseRaw = daily.sunrise?.[0];
  const sunsetRaw = daily.sunset?.[0];
  const sunrise = sunriseRaw != null ? new Date(sunriseRaw) : null;
  const sunset = sunsetRaw != null ? new Date(sunsetRaw) : null;

  const isValid = (d: Date | null): d is Date => d != null && !Number.isNaN(d.getTime());

  const fmt = (d: Date | null) =>
    isValid(d)
      ? d.toLocaleTimeString("en-ZW", { hour: "2-digit", minute: "2-digit", hour12: false })
      : "--:--";

  const hasDaylight = isValid(sunrise) && isValid(sunset);
  const daylightMs = hasDaylight ? sunset.getTime() - sunrise.getTime() : 0;
  const daylightHours = hasDaylight ? Math.floor(daylightMs / (1000 * 60 * 60)) : 0;
  const daylightMinutes = hasDaylight
    ? Math.round((daylightMs % (1000 * 60 * 60)) / (1000 * 60))
    : 0;
  const daylightLabel = hasDaylight ? `${daylightHours}h ${daylightMinutes}m` : "--";

  return (
    <section aria-labelledby="sun-times-heading">
      <div className="baobab">
        <h2 id="sun-times-heading" className="giraffe">Sun</h2>
        <div className="mt-3 flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <SunriseIcon size={20} className="text-warmth" aria-hidden="true" />
            <div>
              <p className="text-base text-text-tertiary">Sunrise</p>
              <p className="text-base font-semibold text-text-primary" aria-label={`Sunrise at ${fmt(sunrise)}`}>{fmt(sunrise)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SunsetIcon size={20} className="text-accent" aria-hidden="true" />
            <div>
              <p className="text-base text-text-tertiary">Sunset</p>
              <p className="text-base font-semibold text-text-primary" aria-label={`Sunset at ${fmt(sunset)}`}>{fmt(sunset)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SunIcon size={20} className="text-warmth" aria-hidden="true" />
            <div>
              <p className="text-base text-text-tertiary">Daylight</p>
              <p className="text-base font-semibold text-text-primary" aria-label={hasDaylight ? `${daylightHours} hours and ${daylightMinutes} minutes of daylight` : "Daylight unavailable"}>{daylightLabel}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
