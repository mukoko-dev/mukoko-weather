import { WeatherIcon, WindIcon, DropletIcon, ThermometerIcon, EyeIcon, GaugeIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, windDirection, uvLevel, type CurrentWeather, type DailyWeather } from "@/lib/weather";

interface Props {
  current: CurrentWeather;
  locationName: string;
  daily?: DailyWeather;
}

export function CurrentConditions({ current, locationName, daily }: Props) {
  console.log("[CurrentConditions] render for", locationName);
  const info = weatherCodeToInfo(current.weather_code);
  const uv = uvLevel(current.uv_index);
  const wind = windDirection(current.wind_direction_10m);
  const todayHigh = daily ? Math.round(daily.temperature_2m_max[0]) : null;
  const todayLow = daily ? Math.round(daily.temperature_2m_min[0]) : null;

  return (
    <section aria-labelledby="current-conditions-heading">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <h2 id="current-conditions-heading" className="sr-only">
          Current weather conditions in {locationName}
        </h2>
        {/* Main temperature display */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-secondary">{locationName}</p>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="font-mono text-7xl font-bold tracking-tighter text-text-primary sm:text-8xl" aria-label={`${Math.round(current.temperature_2m)} degrees Celsius`}>
                {Math.round(current.temperature_2m)}
              </span>
              <span className="font-sans text-3xl font-light text-text-tertiary" aria-hidden="true">°</span>
            </div>
            <p className="mt-1 text-base font-semibold text-text-primary">{info.label}</p>
            <p className="mt-1 text-sm text-text-secondary">
              Feels like {Math.round(current.apparent_temperature)}°C
              {todayHigh !== null && todayLow !== null && (
                <span className="ml-1">
                  · High {todayHigh}° Low {todayLow}°
                </span>
              )}
            </p>
          </div>
          <WeatherIcon
            icon={current.is_day ? info.icon : "moon"}
            size={80}
            className="text-primary"
          />
        </div>

        {/* Quick stats grid */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3" role="list" aria-label="Weather statistics">
          <QuickStat
            icon={<DropletIcon size={18} />}
            label="Humidity"
            value={`${current.relative_humidity_2m}%`}
          />
          <QuickStat
            icon={<WindIcon size={18} />}
            label="Wind"
            value={`${Math.round(current.wind_speed_10m)} km/h ${wind}`}
          />
          <QuickStat
            icon={<WindIcon size={18} />}
            label="Wind Gusts"
            value={`${Math.round(current.wind_gusts_10m)} km/h`}
          />
          <QuickStat
            icon={<GaugeIcon size={18} />}
            label="UV Index"
            value={`${current.uv_index} — ${uv.label}`}
          />
          <QuickStat
            icon={<ThermometerIcon size={18} />}
            label="Pressure"
            value={`${Math.round(current.surface_pressure)} hPa`}
          />
          <QuickStat
            icon={<EyeIcon size={18} />}
            label="Cloud Cover"
            value={`${current.cloud_cover}%`}
          />
          <QuickStat
            icon={<DropletIcon size={18} />}
            label="Precipitation"
            value={`${current.precipitation} mm`}
          />
          {todayHigh !== null && todayLow !== null && daily && (
            <QuickStat
              icon={<ThermometerIcon size={18} />}
              label="Feels Like"
              value={`${Math.round(daily.apparent_temperature_max[0])}° / ${Math.round(daily.apparent_temperature_min[0])}°`}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function QuickStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div role="listitem" className="flex min-w-0 items-center gap-3 rounded-[var(--radius-input)] bg-surface-base p-3">
      <span className="shrink-0 text-text-tertiary" aria-hidden="true">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-text-tertiary">{label}</p>
        <p className="text-sm font-medium text-text-primary" aria-label={`${label}: ${value}`}>{value}</p>
      </div>
    </div>
  );
}
