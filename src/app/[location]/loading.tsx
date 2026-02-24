import { WeatherLoadingScene } from "@/components/weather/WeatherLoadingScene";

export default function LocationLoading() {
  // WeatherLoadingScene extracts slug from usePathname() internally
  return <WeatherLoadingScene />;
}
