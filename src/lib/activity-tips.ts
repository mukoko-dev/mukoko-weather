/**
 * Deterministic, weather-driven tips for activity cards.
 *
 * Given the forecast and an activity, returns up to MAX_TIPS short,
 * actionable tips ("Rain likely around 14:00 — finish field work in the
 * morning"). Purely rule-based — no AI call, no network — so tips render
 * instantly with the card and never cost tokens. Category-specific wording
 * keeps the advice relevant to what the user actually does.
 */

import type { Activity, ActivityCategory } from "./activities";
import type { WeatherData } from "./weather";

export const MAX_TIPS = 3;

/** Hours of forecast scanned for upcoming conditions (rain windows, UV peaks). */
const LOOKAHEAD_HOURS = 12;

interface HourSlice {
  /** Hour label like "14:00" */
  label: string;
  precipProb: number;
  temp: number;
  wind: number;
  gust: number;
  uv: number;
  weatherCode: number;
}

function nextHours(weather: WeatherData, count: number): HourSlice[] {
  const hourly = weather.hourly;
  if (!hourly?.time?.length) return [];

  const now = new Date();
  const currentHour = now.getHours();
  const startIndex = hourly.time.findIndex(
    (t) =>
      new Date(t).getHours() >= currentHour &&
      new Date(t).getDate() === now.getDate(),
  );
  const start = startIndex >= 0 ? startIndex : 0;

  const slices: HourSlice[] = [];
  for (let i = 0; i < count && start + i < hourly.time.length; i++) {
    const idx = start + i;
    slices.push({
      label: `${String(new Date(hourly.time[idx]).getHours()).padStart(2, "0")}:00`,
      precipProb: hourly.precipitation_probability?.[idx] ?? 0,
      temp: hourly.temperature_2m?.[idx] ?? 0,
      wind: hourly.wind_speed_10m?.[idx] ?? 0,
      gust: hourly.wind_gusts_10m?.[idx] ?? 0,
      uv: hourly.uv_index?.[idx] ?? 0,
      weatherCode: hourly.weather_code?.[idx] ?? 0,
    });
  }
  return slices;
}

type TipsByCategory = Partial<Record<ActivityCategory, string>> & { default: string };

function pick(byCategory: TipsByCategory, category: ActivityCategory): string {
  return byCategory[category] ?? byCategory.default;
}

/**
 * Generate up to MAX_TIPS weather-driven tips for an activity, ordered by
 * urgency (safety first, then planning, then comfort). Returns at least one
 * tip — a calm-conditions note when nothing needs flagging.
 */
export function getActivityTips(
  activity: Pick<Activity, "id" | "category" | "label">,
  weather: WeatherData,
): string[] {
  const tips: string[] = [];
  const category = activity.category;
  const hours = nextHours(weather, LOOKAHEAD_HOURS);
  const current = weather.current;

  // 1. Thunderstorm — safety first
  const storm = hours.find((h) => h.weatherCode >= 95);
  if (storm || (current?.weather_code ?? 0) >= 95) {
    tips.push(
      pick(
        {
          farming: "Thunderstorms expected — keep workers and livestock away from open fields and tall trees.",
          mining: "Thunderstorms expected — pause exposed surface operations and crane work until it passes.",
          travel: "Thunderstorms expected — allow extra travel time and avoid low-lying crossings.",
          tourism: "Thunderstorms expected — plan indoor alternatives and avoid exposed viewpoints.",
          sports: "Thunderstorms expected — move training indoors; open pitches are unsafe in lightning.",
          default: "Thunderstorms expected — stay indoors while storms pass and unplug sensitive electronics.",
        },
        category,
      ),
    );
  }

  // 2. Rain window — planning
  const rain = hours.find((h) => h.precipProb >= 60);
  if (rain && !storm) {
    tips.push(
      pick(
        {
          farming: `Rain likely around ${rain.label} — finish spraying and field work before then.`,
          mining: `Rain likely around ${rain.label} — plan wet-ground procedures for haul roads.`,
          travel: `Rain likely around ${rain.label} — expect slower roads and reduced visibility.`,
          tourism: `Rain likely around ${rain.label} — schedule outdoor sightseeing earlier.`,
          sports: `Rain likely around ${rain.label} — plan outdoor sessions before then.`,
          default: `Rain likely around ${rain.label} — plan outdoor time earlier or have cover ready.`,
        },
        category,
      ),
    );
  }

  // 3. Strong wind
  const windy = hours.find((h) => h.wind >= 30 || h.gust >= 45);
  if (windy) {
    tips.push(
      pick(
        {
          farming: "Strong winds ahead — hold off on spraying; drift will waste chemicals and harm neighbouring crops.",
          mining: "Strong winds ahead — expect dust; check suppression and secure loose materials.",
          travel: "Strong winds ahead — grip the wheel firmly on open stretches and give trucks extra room.",
          tourism: "Strong winds ahead — secure tents and loose gear at camp.",
          sports: "Strong winds ahead — expect it to affect ball flight and cycling; plan sheltered routes.",
          default: "Strong winds ahead — secure loose items outdoors.",
        },
        category,
      ),
    );
  }

  // 4. UV peak
  const uvPeak = Math.max(0, ...hours.map((h) => h.uv));
  if (uvPeak >= 8) {
    tips.push(
      pick(
        {
          farming: "UV will be very high — schedule field work before 10:00 and after 15:00; hats and water for workers.",
          mining: "UV will be very high — rotate exposed crews and enforce sun protection.",
          sports: "UV will be very high — train early morning or late afternoon; sunscreen for midday events.",
          tourism: "UV will be very high — pack sunscreen and plan shade breaks between 10:00 and 15:00.",
          default: "UV will be very high today — limit direct sun between 10:00 and 15:00.",
        },
        category,
      ),
    );
  }

  // 5. Frost risk — overnight lows sit beyond the 12h planning window, so
  // scan a full 24 hours for the daily minimum.
  const dayHours = nextHours(weather, 24);
  const minTemp = Math.min(...dayHours.map((h) => h.temp), current?.temperature_2m ?? Infinity);
  if (minTemp <= 3) {
    tips.push(
      pick(
        {
          farming: "Frost risk — cover seedlings, move potted plants, and give livestock windbreaks overnight.",
          travel: "Near-freezing temperatures — watch for icy patches on early-morning roads.",
          default: "Near-freezing temperatures expected — dress warmly for early mornings.",
        },
        category,
      ),
    );
  }

  // 6. Heat
  const maxTemp = Math.max(...hours.map((h) => h.temp), current?.temperature_2m ?? -Infinity);
  if (maxTemp >= 32) {
    tips.push(
      pick(
        {
          farming: "High heat — irrigate early morning or evening to cut evaporation losses; shade and water for livestock.",
          mining: "High heat — enforce hydration breaks and watch crews for heat stress.",
          sports: "High heat — hydrate before and during sessions; avoid hard efforts at midday.",
          default: "High heat today — drink water regularly and take breaks in the shade.",
        },
        category,
      ),
    );
  }

  // 7. High humidity — farming disease pressure
  if (category === "farming" && (current?.relative_humidity_2m ?? 0) >= 80) {
    tips.push(
      "Humidity is high — fungal disease pressure rises; scout susceptible crops and avoid overhead irrigation.",
    );
  }

  // Calm-conditions fallback so the card always says something useful
  if (tips.length === 0) {
    tips.push(`Conditions look stable — a good stretch for ${activity.label.toLowerCase()}.`);
  }

  return tips.slice(0, MAX_TIPS);
}
