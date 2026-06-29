import { SunriseIcon, SunsetIcon, SunIcon } from "@/lib/weather-icons";
import type { DailyWeather } from "@/lib/weather";

interface Props {
  daily: DailyWeather;
}

export function SunTimes({ daily }: Props) {
  const sunrise = new Date(daily.sunrise[0]);
  const sunset = new Date(daily.sunset[0]);
  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-ZW", { hour: "2-digit", minute: "2-digit", hour12: false });

  const daylightMs = sunset.getTime() - sunrise.getTime();
  const daylightHours = Math.floor(daylightMs / (1000 * 60 * 60));
  const daylightMinutes = Math.round((daylightMs % (1000 * 60 * 60)) / (1000 * 60));

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
              <p className="text-base font-semibold text-text-primary" aria-label={`${daylightHours} hours and ${daylightMinutes} minutes of daylight`}>{daylightHours}h {daylightMinutes}m</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
