import type { HourlyWeather } from "@/lib/weather";
import { HourlyChart } from "./HourlyChart";

interface Props {
  hourly: HourlyWeather;
}

export function HourlyForecast({ hourly }: Props) {
  return (
    <section aria-labelledby="hourly-forecast-heading">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-5 shadow-sm sm:p-6">
        <h2 id="hourly-forecast-heading" className="text-lg font-semibold text-text-primary font-heading">24-Hour Forecast</h2>
        <HourlyChart hourly={hourly} />
      </div>
    </section>
  );
}
