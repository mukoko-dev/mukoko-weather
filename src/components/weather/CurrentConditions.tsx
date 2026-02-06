import { WeatherIcon, WindIcon, DropletIcon, ThermometerIcon, EyeIcon, GaugeIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, windDirection, uvLevel, type CurrentWeather } from "@/lib/weather";

interface Props {
  current: CurrentWeather;
  locationName: string;
}

export function CurrentConditions({ current, locationName }: Props) {
  const info = weatherCodeToInfo(current.weather_code);
  const uv = uvLevel(current.uv_index);
  const wind = windDirection(current.wind_direction_10m);

  return (
    <section aria-label={`Current weather conditions in ${locationName}`}>
      <div className="rounded-[var(--radius-card)] bg-surface-card p-6 shadow-sm">
        {/* Main temperature display */}
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-text-secondary">{locationName}</p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-serif text-6xl font-bold text-text-primary">
                {Math.round(current.temperature_2m)}
              </span>
              <span className="text-2xl text-text-secondary">°C</span>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              Feels like {Math.round(current.apparent_temperature)}°C
            </p>
            <p className="mt-2 text-base font-medium text-text-primary">{info.label}</p>
          </div>
          <WeatherIcon
            icon={current.is_day ? info.icon : "moon"}
            size={64}
            className="text-primary"
          />
        </div>

        {/* Quick stats grid */}
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
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
        </div>
      </div>
    </section>
  );
}

function QuickStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-input)] bg-surface-base p-3">
      <span className="text-text-tertiary">{icon}</span>
      <div>
        <p className="text-xs text-text-tertiary">{label}</p>
        <p className="text-sm font-medium text-text-primary">{value}</p>
      </div>
    </div>
  );
}
