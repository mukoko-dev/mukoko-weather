"use client";

import { useEffect, useRef } from "react";
import { WeatherIcon, nightIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, type HourlyWeather } from "@/lib/weather";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { useHydrated } from "@/lib/use-hydrated";
import {
  currentHourIndex,
  locationClockLabel,
  resolveOffsetSeconds,
} from "@/lib/location-time";

/** Accessible name for the focusable horizontal scroll region. */
export const HOURLY_SCROLL_LABEL = "Hourly forecast, scroll horizontally";

interface Props {
  hourly: HourlyWeather;
  /** The location's UTC offset (payload `utc_offset_seconds`). "Now" and
   *  every hour label are read in the PLACE's time, not the viewer's. */
  utcOffsetSeconds?: number;
}

/**
 * Horizontal scrollable hour-by-hour weather cards.
 * Renders eagerly above CurrentConditions on the location page.
 */
export function HourlyScrollCards({ hourly, utcOffsetSeconds }: Props) {
  // The start of the strip is chosen from the current instant (`new Date()`)
  // read in the LOCATION's offset, which the server can't match at SSR time
  // (it renders minutes earlier, possibly a different hour) — computing it
  // during hydration would slice a different set of hours and mismatch the
  // server HTML (React error 418). Gate on `useHydrated()`: the server and the
  // first client render both start at index 0 (identical HTML), then after
  // hydration we advance to the current hour and label the first card "Now".
  const hydrated = useHydrated();
  const offset = resolveOffsetSeconds(utcOffsetSeconds);
  const start = hydrated ? currentHourIndex(hourly.time, offset) : 0;
  const hours = hourly.time.slice(start, start + 24);

  // The one-sentence outlook lives in the hero (CurrentConditions) — it is
  // deliberately NOT repeated here, so the strip is hours only.

  // The horizontal scroller is Radix's Viewport, which ScrollArea doesn't let
  // us attribute directly. Keyboard users need it focusable (axe:
  // scrollable-region-focusable), so set the focus/landmark attributes on the
  // viewport element once it mounts. Radix never manages these attributes, so
  // they survive re-renders.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", HOURLY_SCROLL_LABEL);
  }, []);

  return (
    <div className="baobab overflow-hidden p-3">
      <ScrollArea className="w-full" type="hover" viewportRef={scrollRef}>
        <div
          className="flex gap-2.5 pb-2 [overscroll-behavior-x:contain]"
          role="list"
          aria-label="Hourly weather forecast"
        >
          {hours.map((time, i) => {
            const idx = start + i;
            const info = weatherCodeToInfo(hourly.weather_code[idx]);
            const isDay = hourly.is_day[idx];
            const temp = Math.round(hourly.temperature_2m[idx]);
            const timeLabel =
              hydrated && i === 0 ? "Now" : locationClockLabel(time, offset);
            return (
              <div
                key={time}
                role="listitem"
                aria-label={`${timeLabel}: ${temp} degrees, ${info.label}`}
                className="flex min-w-[60px] flex-col items-center gap-1.5 rounded-[var(--radius-input)] bg-surface-base px-2.5 py-2 transition-colors hover:bg-surface-elevated"
              >
                <span className="text-base font-medium text-text-secondary">
                  {timeLabel}
                </span>
                <WeatherIcon
                  icon={isDay ? info.icon : nightIcon(info.icon)}
                  size={20}
                  className="text-primary"
                />
                <span className="text-base font-semibold text-text-primary">
                  {temp}°
                </span>
                {(hourly.precipitation_probability?.[idx] ?? 0) > 0 && (
                  <span className="text-base font-semibold text-rain">
                    {hourly.precipitation_probability[idx]}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
