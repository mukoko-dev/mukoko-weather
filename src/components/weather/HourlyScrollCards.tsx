"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { WeatherIcon, nightIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, type HourlyWeather } from "@/lib/weather";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { SectionHeader } from "@/components/ui/section-header";
import { useHydrated } from "@/lib/use-hydrated";
import { heroOutlook } from "@/lib/hero";
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
  /** Panel heading (e.g. "Conditions") with an optional "Full forecast"
   *  action. `headingId` is the id the section's `aria-labelledby` points at. */
  heading?: {
    headingId: string;
    title: string;
    action?: { label: string; href: string };
  };
  /** "sky" paints the translucent bordered card the location page shows
   *  right under the sky hero (`.kestrel-card`); "card" is the ordinary
   *  opaque card used wherever the strip sits lower in the page. */
  variant?: "sky" | "card";
  /** Quiet line at the foot of the card (the season). */
  footer?: ReactNode;
}

/**
 * The Conditions card: the one-sentence outlook and the horizontal
 * hour-by-hour strip. Renders eagerly right under the hero on the location page.
 */
export function HourlyScrollCards({
  hourly,
  utcOffsetSeconds,
  heading,
  variant = "card",
  footer,
}: Props) {
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
  // The one plain sentence about the day ahead (deterministic, no AI call),
  // read in the PLACE's time. Hydration-gated like the start hour: it needs
  // the current instant, which the server render cannot match.
  const outlook = hydrated ? heroOutlook(hourly, new Date(), offset) : null;

  // The one-sentence outlook sits above the strip, in this card.

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
    <div
      data-hourly-strip
      className={
        variant === "sky"
          ? "kestrel-card overflow-hidden"
          : "baobab overflow-hidden shadow-none"
      }
    >
      {heading && (
        <SectionHeader
          headingId={heading.headingId}
          title={heading.title}
          action={heading.action}
        />
      )}
      {outlook && (
        <p className="gazelle mt-1 border-b border-border pb-3">{outlook}</p>
      )}
      <ScrollArea className="mt-3 w-full" type="hover" viewportRef={scrollRef}>
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
                <span className="text-base font-normal text-text-secondary">
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
      {footer && (
        <div className="mt-3 flex justify-center border-t border-border pt-3">
          {footer}
        </div>
      )}
    </div>
  );
}
