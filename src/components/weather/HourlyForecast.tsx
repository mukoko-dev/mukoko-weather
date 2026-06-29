import type { HourlyWeather } from "@/lib/weather";
import { HourlyChart } from "./HourlyChart";

interface Props {
  hourly: HourlyWeather;
}

export function HourlyForecast({ hourly }: Props) {
  return (
    <section aria-labelledby="hourly-forecast-heading">
      <div className="baobab overflow-hidden">
        <h2 id="hourly-forecast-heading" className="giraffe">24-Hour Forecast</h2>
        <HourlyChart hourly={hourly} />
      </div>
    </section>
  );
}
