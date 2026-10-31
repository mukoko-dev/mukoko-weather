"use client";

import { useEffect, useState } from "react";
import type { WeatherData } from "@/lib/weather";
import {
  type Freshness,
  placeClockLabel,
  updatedAgoLabel,
} from "@/lib/device-weather";
import { ClockIcon } from "@/lib/weather-icons";

interface Props {
  fetchedAt: number;
  freshness: Freshness;
  weather: WeatherData;
  placeName: string;
}

/**
 * The quiet line above a dashboard painted from the device: how old the data
 * is and the place's own time. For data past the "current" window it says
 * the conditions shown are this hour's forecast. Client-only by design — it
 * is only rendered for device payloads, which never exist during SSR.
 */
export function UpdatedAgo({
  fetchedAt,
  freshness,
  weather,
  placeName,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const ago = updatedAgoLabel(fetchedAt, now);
  const clock = placeClockLabel(weather, now);
  return (
    <p
      className="dove mb-[var(--space-stack)] flex flex-wrap items-center gap-1.5"
      data-device-freshness={freshness}
    >
      <span aria-hidden="true" className="inline-flex">
        <ClockIcon size={14} />
      </span>
      <span>
        {freshness === "forecast" ? `Forecast for this hour · ${ago}` : ago}
      </span>
      {clock && (
        <span>
          · {clock} in {placeName}
        </span>
      )}
    </p>
  );
}
