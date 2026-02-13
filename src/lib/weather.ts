/* Open-Meteo weather API client */

export interface CurrentWeather {
  temperature_2m: number;
  relative_humidity_2m: number;
  apparent_temperature: number;
  precipitation: number;
  weather_code: number;
  cloud_cover: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  wind_gusts_10m: number;
  uv_index: number;
  surface_pressure: number;
  is_day: number;
}

export interface HourlyWeather {
  time: string[];
  temperature_2m: number[];
  apparent_temperature: number[];
  relative_humidity_2m: number[];
  precipitation_probability: number[];
  precipitation: number[];
  weather_code: number[];
  visibility: number[];
  cloud_cover: number[];
  surface_pressure: number[];
  wind_speed_10m: number[];
  wind_direction_10m: number[];
  wind_gusts_10m: number[];
  uv_index: number[];
  is_day: number[];
}

export interface DailyWeather {
  time: string[];
  weather_code: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  apparent_temperature_max: number[];
  apparent_temperature_min: number[];
  sunrise: string[];
  sunset: string[];
  uv_index_max: number[];
  precipitation_sum: number[];
  precipitation_probability_max: number[];
  wind_speed_10m_max: number[];
  wind_gusts_10m_max: number[];
}

export interface WeatherData {
  current: CurrentWeather;
  hourly: HourlyWeather;
  daily: DailyWeather;
  current_units: Record<string, string>;
  /** Activity-specific insights — only available when Tomorrow.io is the provider */
  insights?: WeatherInsights;
}

/** Extended weather data from Tomorrow.io for activity-aware insight cards */
export interface WeatherInsights {
  // Farming — Growing Degree Days (today)
  gdd10To30?: number;  // Maize & soybean
  gdd10To31?: number;  // Sunflower
  gdd08To30?: number;  // Sorghum & green gram
  gdd03To25?: number;  // Potatoes
  evapotranspiration?: number;  // mm (today)
  dewPoint?: number;            // °C (current)
  precipitationType?: number;   // 0=none, 1=rain, 2=snow, 3=freezing rain, 4=sleet

  // Safety — outdoor activities
  thunderstormProbability?: number;  // % (current)
  heatStressIndex?: number;          // 0–30+ (current)
  uvHealthConcern?: number;          // 0–11+ (current)

  // Tourism / photography
  moonPhase?: number;        // 0–7
  cloudBase?: number | null; // km (current)
  cloudCeiling?: number | null; // km (current)
  visibility?: number;       // km (current)
}

export interface FrostAlert {
  risk: "severe" | "high" | "moderate";
  lowestTemp: number;
  startTime: string;
  endTime: string;
  message: string;
}

const CURRENT_PARAMS = [
  "temperature_2m",
  "relative_humidity_2m",
  "apparent_temperature",
  "precipitation",
  "weather_code",
  "cloud_cover",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "uv_index",
  "surface_pressure",
  "is_day",
].join(",");

const HOURLY_PARAMS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation_probability",
  "precipitation",
  "weather_code",
  "visibility",
  "cloud_cover",
  "surface_pressure",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "uv_index",
  "is_day",
].join(",");

const DAILY_PARAMS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "sunrise",
  "sunset",
  "uv_index_max",
  "precipitation_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
].join(",");

export async function fetchWeather(lat: number, lon: number): Promise<WeatherData> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current: CURRENT_PARAMS,
    hourly: HOURLY_PARAMS,
    daily: DAILY_PARAMS,
    timezone: "Africa/Harare",
    forecast_days: "7",
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    next: { revalidate: 900 }, // cache for 15 minutes
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status}`);
  }

  return res.json();
}

export function checkFrostRisk(hourly: HourlyWeather): FrostAlert | null {
  const frostHours = hourly.temperature_2m
    .map((temp, i) => ({ temp, time: hourly.time[i] }))
    .filter((h) => {
      const hour = new Date(h.time).getHours();
      return (hour >= 22 || hour <= 8) && h.temp <= 3;
    });

  if (frostHours.length > 0) {
    const lowestTemp = Math.min(...frostHours.map((h) => h.temp));
    return {
      risk: lowestTemp <= 0 ? "severe" : lowestTemp <= 2 ? "high" : "moderate",
      lowestTemp,
      startTime: frostHours[0].time,
      endTime: frostHours[frostHours.length - 1].time,
      message:
        lowestTemp <= 0
          ? `Severe frost warning: ${lowestTemp}°C expected. Protect all crops immediately.`
          : `Frost risk tonight: temperatures dropping to ${lowestTemp}°C. Cover sensitive plants.`,
    };
  }
  return null;
}

/** WMO Weather interpretation codes → label & icon */
export function weatherCodeToInfo(code: number): { label: string; icon: string } {
  const map: Record<number, { label: string; icon: string }> = {
    0: { label: "Clear sky", icon: "sun" },
    1: { label: "Mainly clear", icon: "sun" },
    2: { label: "Partly cloudy", icon: "cloud-sun" },
    3: { label: "Overcast", icon: "cloud" },
    45: { label: "Fog", icon: "cloud-fog" },
    48: { label: "Depositing rime fog", icon: "cloud-fog" },
    51: { label: "Light drizzle", icon: "cloud-drizzle" },
    53: { label: "Moderate drizzle", icon: "cloud-drizzle" },
    55: { label: "Dense drizzle", icon: "cloud-drizzle" },
    61: { label: "Slight rain", icon: "cloud-rain" },
    63: { label: "Moderate rain", icon: "cloud-rain" },
    65: { label: "Heavy rain", icon: "cloud-rain" },
    66: { label: "Light freezing rain", icon: "cloud-hail" },
    67: { label: "Heavy freezing rain", icon: "cloud-hail" },
    71: { label: "Slight snow", icon: "snowflake" },
    73: { label: "Moderate snow", icon: "snowflake" },
    75: { label: "Heavy snow", icon: "snowflake" },
    77: { label: "Snow grains", icon: "snowflake" },
    80: { label: "Slight rain showers", icon: "cloud-sun-rain" },
    81: { label: "Moderate rain showers", icon: "cloud-rain" },
    82: { label: "Violent rain showers", icon: "cloud-rain" },
    85: { label: "Slight snow showers", icon: "snowflake" },
    86: { label: "Heavy snow showers", icon: "snowflake" },
    95: { label: "Thunderstorm", icon: "cloud-lightning" },
    96: { label: "Thunderstorm with slight hail", icon: "cloud-lightning" },
    99: { label: "Thunderstorm with heavy hail", icon: "cloud-lightning" },
  };
  return map[code] ?? { label: "Unknown", icon: "cloud" };
}

/** Zimbabwe seasons */
export function getZimbabweSeason(date: Date = new Date()): {
  name: string;
  shona: string;
  description: string;
} {
  const month = date.getMonth() + 1; // 1-12
  if (month >= 11 || month <= 3) {
    return { name: "Main rains", shona: "Masika", description: "Flooding, road damage, planting" };
  }
  if (month >= 5 && month <= 8) {
    return { name: "Cool dry", shona: "Chirimo", description: "Frost, cold snaps, veld fires" };
  }
  if (month >= 9 && month <= 10) {
    return { name: "Hot dry", shona: "Zhizha", description: "Heat stress, UV, water scarcity" };
  }
  // month 4 (April)
  return { name: "Short rains", shona: "Munakamwe", description: "Harvest, late rains" };
}

export function windDirection(degrees: number): string {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round(degrees / 22.5) % 16;
  return dirs[index];
}

export function uvLevel(index: number): { label: string; color: string } {
  if (index <= 2) return { label: "Low", color: "text-success" };
  if (index <= 5) return { label: "Moderate", color: "text-warmth" };
  if (index <= 7) return { label: "High", color: "text-accent" };
  if (index <= 10) return { label: "Very High", color: "text-earth" };
  return { label: "Extreme", color: "text-primary" };
}
