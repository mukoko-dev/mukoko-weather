import type { HourlyWeather } from "@/lib/weather";
import { HourlyChart } from "./HourlyChart";

interface Props {
  hourly: HourlyWeather;
  /** The location's UTC offset (payload `utc_offset_seconds`). */
  utcOffsetSeconds?: number;
}

export function HourlyForecast({ hourly, utcOffsetSeconds }: Props) {
  return (
    <section aria-labelledby="hourly-forecast-heading">
      <div className="baobab overflow-hidden">
        <h2 id="hourly-forecast-heading" className="giraffe">
          24-Hour Forecast
        </h2>
        <HourlyChart hourly={hourly} utcOffsetSeconds={utcOffsetSeconds} />
      </div>
    </section>
  );
}
