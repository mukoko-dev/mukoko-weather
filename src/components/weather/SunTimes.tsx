import { SunriseIcon, SunsetIcon, SunIcon } from "@/lib/weather-icons";
import type { DailyWeather } from "@/lib/weather";
import { resolveOffsetSeconds, wallClockMs, wallClockLabel } from "@/lib/location-time";

interface Props {
  daily: DailyWeather;
  /** The location's UTC offset (payload `utc_offset_seconds`) — sunrise and
   *  sunset show the PLACE's local time, wherever the viewer is. */
  utcOffsetSeconds?: number;
}

export function SunTimes({ daily, utcOffsetSeconds }: Props) {
  const offset = resolveOffsetSeconds(utcOffsetSeconds);
  const sunrise = wallClockMs(daily.sunrise?.[0], offset);
  const sunset = wallClockMs(daily.sunset?.[0], offset);

  const fmt = (wall: number | null) =>
    wall === null ? "--:--" : wallClockLabel(wall);

  const hasDaylight = sunrise !== null && sunset !== null;
  const daylightMs = hasDaylight ? sunset - sunrise : 0;
  const daylightHours = hasDaylight
    ? Math.floor(daylightMs / (1000 * 60 * 60))
    : 0;
  const daylightMinutes = hasDaylight
    ? Math.round((daylightMs % (1000 * 60 * 60)) / (1000 * 60))
    : 0;
  const daylightLabel = hasDaylight
    ? `${daylightHours}h ${daylightMinutes}m`
    : "--";

  return (
    <section aria-labelledby="sun-times-heading">
      <div className="baobab">
        <h2 id="sun-times-heading" className="giraffe">
          Sun
        </h2>
        <div className="mt-3 flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <SunriseIcon size={20} className="text-warmth" aria-hidden="true" />
            <div>
              <p className="text-base text-text-tertiary">Sunrise</p>
              <p
                className="text-base font-semibold text-text-primary"
                aria-label={`Sunrise at ${fmt(sunrise)}`}
              >
                {fmt(sunrise)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SunsetIcon size={20} className="text-accent" aria-hidden="true" />
            <div>
              <p className="text-base text-text-tertiary">Sunset</p>
              <p
                className="text-base font-semibold text-text-primary"
                aria-label={`Sunset at ${fmt(sunset)}`}
              >
                {fmt(sunset)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SunIcon size={20} className="text-warmth" aria-hidden="true" />
            <div>
              <p className="text-base text-text-tertiary">Daylight</p>
              <p
                className="text-base font-semibold text-text-primary"
                aria-label={
                  hasDaylight
                    ? `${daylightHours} hours and ${daylightMinutes} minutes of daylight`
                    : "Daylight unavailable"
                }
              >
                {daylightLabel}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
