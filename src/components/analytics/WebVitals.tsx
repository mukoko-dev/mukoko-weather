"use client";

import { useReportWebVitals } from "next/web-vitals";
import { sendVital, toVitalEvent, type VitalWindow } from "@/lib/web-vitals";

/**
 * Reports how fast the page really opened (#551). Renders nothing. The
 * pathname is read when the number is reported, not when the page mounted:
 * LCP and INP settle as the page is hidden, after any client navigation.
 */
export function WebVitals() {
  useReportWebVitals((metric) => {
    const nav = navigator as Navigator & {
      connection?: { effectiveType?: string };
    };
    const event = toVitalEvent(
      metric,
      window.location.pathname,
      nav.connection?.effectiveType,
    );
    if (event) sendVital(event, window as unknown as VitalWindow);
  });
  return null;
}
