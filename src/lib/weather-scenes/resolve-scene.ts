import type { WeatherSceneType } from "./types";

/**
 * Maps a WMO weather code (0–99) to a Three.js scene type.
 * Optionally overrides to "windy" if wind speed exceeds 40 km/h
 * and the base scene is calm (clear or partly-cloudy).
 */
export function resolveScene(
  weatherCode: number,
  windSpeed?: number,
): WeatherSceneType {
  let scene: WeatherSceneType;

  switch (weatherCode) {
    // Clear
    case 0:
    case 1:
      scene = "clear";
      break;

    // Partly cloudy
    case 2:
      scene = "partly-cloudy";
      break;

    // Overcast
    case 3:
      scene = "cloudy";
      break;

    // Fog
    case 45:
    case 48:
      scene = "fog";
      break;

    // Drizzle
    case 51:
    case 53:
    case 55:
    // Rain
    case 61:
    case 63:
    case 65:
    // Freezing rain
    case 56:
    case 57:
    case 66:
    case 67:
    // Rain showers
    case 80:
    case 81:
    case 82:
      scene = "rain";
      break;

    // Snow
    case 71:
    case 73:
    case 75:
    case 77:
    // Snow showers
    case 85:
    case 86:
      scene = "snow";
      break;

    // Thunderstorm
    case 95:
    case 96:
    case 99:
      scene = "thunderstorm";
      break;

    default:
      scene = "partly-cloudy";
      break;
  }

  // Wind override for calm scenes
  if (
    windSpeed != null &&
    windSpeed > 40 &&
    (scene === "clear" || scene === "partly-cloudy")
  ) {
    scene = "windy";
  }

  return scene;
}
