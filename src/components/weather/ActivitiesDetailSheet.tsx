"use client";

import { Suspense, useEffect } from "react";
import type { Activity } from "@/lib/activities";
import type { WeatherData, WeatherInsights } from "@/lib/weather";
import { useAppStore } from "@/lib/store";
import { trackEvent } from "@/lib/analytics";
import { getScrollBehavior } from "@/lib/utils";
import { DetailSheet } from "@/components/ui/detail-sheet";
import { ChartErrorBoundary } from "./ChartErrorBoundary";
import { ActivityInsights } from "./ActivityInsights";
import { activityCardAnchorId } from "./ActivityCard";
import { ActivityInsightsSkeleton } from "./SectionSkeleton";

export interface ActivitiesDetailSheetProps {
  open: boolean;
  onClose: () => void;
  /** Scroll to (and focus) this activity's card once the sheet is open. */
  focusActivityId?: string;
  /** Element that opened the sheet; focus returns to it on close. */
  opener?: HTMLElement | null;
  insights: WeatherInsights;
  activities: Activity[];
  weather: WeatherData;
}

/**
 * The full activity advice behind the Community lane: one card per selected
 * activity with its suitability rating, 24-hour feasibility trend and tips,
 * plus the Edit action. It is mounted only while the sheet is open (Radix
 * unmounts closed content), and the dashboard imports it lazily, so the page
 * carries none of this until someone asks for it.
 */
export function ActivitiesDetailSheet({
  open,
  onClose,
  focusActivityId,
  opener,
  insights,
  activities,
  weather,
}: ActivitiesDetailSheetProps) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);

  useEffect(() => {
    if (open) trackEvent("modal_opened", { modal: "activities" });
  }, [open]);

  // Scroll to the tapped activity and move focus onto its card. The sheet
  // content mounts through a portal, so look the card up after two frames.
  useEffect(() => {
    if (!open || !focusActivityId) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const card = document.getElementById(
          activityCardAnchorId(focusActivityId),
        );
        if (!card) return;
        card.focus({ preventScroll: true });
        card.scrollIntoView({ behavior: getScrollBehavior(), block: "start" });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open, focusActivityId]);

  return (
    <DetailSheet
      open={open}
      title="My activities"
      onClose={onClose}
      returnFocusTo={opener}
      description="How the forecast affects each activity you picked, hour by hour. Ratings come from the same rules as the Community lane."
    >
      <ChartErrorBoundary name="activity advice">
        <Suspense fallback={<ActivityInsightsSkeleton />}>
          <ActivityInsights
            insights={insights}
            activities={activities}
            weather={weather}
            heading="Advice for today"
            onEdit={() => {
              onClose();
              openMyWeather("activities");
            }}
          />
        </Suspense>
      </ChartErrorBoundary>
    </DetailSheet>
  );
}
