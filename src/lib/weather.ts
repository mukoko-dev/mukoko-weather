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

/**
 * Generate fallback weather data using seasonal averages for a Zimbabwe location.
 * Used when all weather providers are unavailable so the page still renders.
 * Temperatures are adjusted for elevation (~6.5°C per 1000m lapse rate).
 */
export function createFallbackWeather(lat: number, lon: number, elevation: number): WeatherData {
  const now = new Date();
  const season = getZimbabweSeason(now);
  const hour = now.getHours();
  const isDay = hour >= 6 && hour < 18 ? 1 : 0;

  // Seasonal base temperatures (°C) at ~1200m reference elevation
  const seasonalBase: Record<string, { high: number; low: number; humidity: number; code: number }> = {
    "Main rains":  { high: 28, low: 17, humidity: 70, code: 2 },
    "Cool dry":    { high: 22, low: 8,  humidity: 40, code: 0 },
    "Hot dry":     { high: 32, low: 18, humidity: 30, code: 0 },
    "Short rains": { high: 25, low: 14, humidity: 55, code: 2 },
  };
  const base = seasonalBase[season.name] ?? seasonalBase["Main rains"];

  // Adjust for elevation: −6.5°C per 1000m above reference (1200m)
  const elevAdj = ((elevation - 1200) / 1000) * -6.5;
  const high = Math.round(base.high + elevAdj);
  const low = Math.round(base.low + elevAdj);
  const midTemp = Math.round((high + low) / 2);

  // Generate 48 hours of hourly data
  const hourlyTimes: string[] = [];
  const hourlyTemps: number[] = [];
  const hourlyApparent: number[] = [];
  const hourlyHumidity: number[] = [];
  const hourlyPrecipProb: number[] = [];
  const hourlyPrecip: number[] = [];
  const hourlyCodes: number[] = [];
  const hourlyVis: number[] = [];
  const hourlyCloud: number[] = [];
  const hourlyPressure: number[] = [];
  const hourlyWindSpeed: number[] = [];
  const hourlyWindDir: number[] = [];
  const hourlyWindGusts: number[] = [];
  const hourlyUV: number[] = [];
  const hourlyIsDay: number[] = [];

  for (let i = 0; i < 48; i++) {
    const t = new Date(now.getTime() + i * 3600_000);
    const h = t.getHours();
    const daylight = h >= 6 && h < 18;
    // Sinusoidal temperature curve: low at 5am, high at 2pm
    const tempFrac = Math.sin(((h - 5) / 24) * Math.PI);
    const temp = Math.round(low + (high - low) * Math.max(0, tempFrac));

    hourlyTimes.push(t.toISOString());
    hourlyTemps.push(temp);
    hourlyApparent.push(temp - 1);
    hourlyHumidity.push(base.humidity);
    hourlyPrecipProb.push(0);
    hourlyPrecip.push(0);
    hourlyCodes.push(base.code);
    hourlyVis.push(10000);
    hourlyCloud.push(base.code === 0 ? 10 : 40);
    hourlyPressure.push(870);
    hourlyWindSpeed.push(8);
    hourlyWindDir.push(90);
    hourlyWindGusts.push(15);
    hourlyUV.push(daylight ? 5 : 0);
    hourlyIsDay.push(daylight ? 1 : 0);
  }

  // Generate 7 days of daily data
  const dailyTimes: string[] = [];
  const dailyHighs: number[] = [];
  const dailyLows: number[] = [];
  const dailyApparentHighs: number[] = [];
  const dailyApparentLows: number[] = [];
  const dailyCodes: number[] = [];
  const dailySunrise: string[] = [];
  const dailySunset: string[] = [];
  const dailyUV: number[] = [];
  const dailyPrecipSum: number[] = [];
  const dailyPrecipProbMax: number[] = [];
  const dailyWindMax: number[] = [];
  const dailyGustMax: number[] = [];

  for (let d = 0; d < 7; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    day.setHours(0, 0, 0, 0);
    const sunrise = new Date(day);
    sunrise.setHours(5, 45, 0, 0);
    const sunset = new Date(day);
    sunset.setHours(18, 15, 0, 0);

    dailyTimes.push(day.toISOString().slice(0, 10));
    dailyHighs.push(high);
    dailyLows.push(low);
    dailyApparentHighs.push(high - 1);
    dailyApparentLows.push(low - 1);
    dailyCodes.push(base.code);
    dailySunrise.push(sunrise.toISOString());
    dailySunset.push(sunset.toISOString());
    dailyUV.push(7);
    dailyPrecipSum.push(0);
    dailyPrecipProbMax.push(0);
    dailyWindMax.push(12);
    dailyGustMax.push(20);
  }

  return {
    current: {
      temperature_2m: midTemp,
      relative_humidity_2m: base.humidity,
      apparent_temperature: midTemp - 1,
      precipitation: 0,
      weather_code: base.code,
      cloud_cover: base.code === 0 ? 10 : 40,
      wind_speed_10m: 8,
      wind_direction_10m: 90,
      wind_gusts_10m: 15,
      uv_index: isDay ? 5 : 0,
      surface_pressure: 870,
      is_day: isDay,
    },
    hourly: {
      time: hourlyTimes,
      temperature_2m: hourlyTemps,
      apparent_temperature: hourlyApparent,
      relative_humidity_2m: hourlyHumidity,
      precipitation_probability: hourlyPrecipProb,
      precipitation: hourlyPrecip,
      weather_code: hourlyCodes,
      visibility: hourlyVis,
      cloud_cover: hourlyCloud,
      surface_pressure: hourlyPressure,
      wind_speed_10m: hourlyWindSpeed,
      wind_direction_10m: hourlyWindDir,
      wind_gusts_10m: hourlyWindGusts,
      uv_index: hourlyUV,
      is_day: hourlyIsDay,
    },
    daily: {
      time: dailyTimes,
      weather_code: dailyCodes,
      temperature_2m_max: dailyHighs,
      temperature_2m_min: dailyLows,
      apparent_temperature_max: dailyApparentHighs,
      apparent_temperature_min: dailyApparentLows,
      sunrise: dailySunrise,
      sunset: dailySunset,
      uv_index_max: dailyUV,
      precipitation_sum: dailyPrecipSum,
      precipitation_probability_max: dailyPrecipProbMax,
      wind_speed_10m_max: dailyWindMax,
      wind_gusts_10m_max: dailyGustMax,
    },
    current_units: {
      temperature_2m: "°C",
      relative_humidity_2m: "%",
      apparent_temperature: "°C",
      precipitation: "mm",
      wind_speed_10m: "km/h",
      wind_gusts_10m: "km/h",
      uv_index: "",
      surface_pressure: "hPa",
      cloud_cover: "%",
    },
  };
}
