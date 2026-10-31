"use client";

import { historyFetchOptions } from "@/lib/history-api";
import { useEffect, useState } from "react";
import { roundCoord } from "./location-privacy";
import { fetchWorker } from "./weather-api";
import {
  parseMonthlyNormals,
  recentDaysFromHistory,
  type ParsedMonthlyNormals,
  type RecentDay,
} from "./climate-averages";

export type ClimateState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "unavailable" };

/**
 * The monthly climate normals for a place, from the Rust Worker
 * (`/v1/normals/monthly`). Fetched only while `enabled` (the Averages detail
 * is open), aborted when it closes.
 */
export function useMonthlyNormals(
  lat: number | undefined,
  lon: number | undefined,
  enabled: boolean,
): ClimateState<ParsedMonthlyNormals> {
  const [state, setState] = useState<ClimateState<ParsedMonthlyNormals>>({
    status: "loading",
  });

  useEffect(() => {
    if (!enabled || typeof lat !== "number" || typeof lon !== "number") return;
    const controller = new AbortController();
    fetchWorker(
      "normals/monthly",
      `lat=${roundCoord(lat)}&lon=${roundCoord(lon)}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseMonthlyNormals(await res.json());
      })
      .then((parsed) =>
        setState(
          parsed
            ? { status: "ready", data: parsed }
            : { status: "unavailable" },
        ),
      )
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [lat, lon, enabled]);

  return state;
}

/** Recorded days (`/v1/history`, the last 30) for a place that has a history. */
export function useRecentDays(
  slug: string | undefined,
  enabled: boolean,
): ClimateState<RecentDay[]> {
  const [state, setState] = useState<ClimateState<RecentDay[]>>({
    status: "loading",
  });

  useEffect(() => {
    if (!enabled || !slug) return;
    const controller = new AbortController();
    fetchWorker(
      "history",
      `location=${encodeURIComponent(slug)}&days=30`,
      { signal: controller.signal },
      historyFetchOptions(30),
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return recentDaysFromHistory(await res.json());
      })
      .then((days) => setState({ status: "ready", data: days }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [slug, enabled]);

  return state;
}
