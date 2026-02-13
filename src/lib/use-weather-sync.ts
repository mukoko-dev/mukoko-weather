"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { WeatherData } from "./weather";
import {
  getWeatherFromIDB,
  setWeatherInIDB,
  getAISummaryFromIDB,
  setAISummaryInIDB,
} from "./weather-idb";

const REFRESH_INTERVAL_MS = 60 * 1000; // 1 minute

interface WeatherSyncState {
  weather: WeatherData | null;
  aiInsight: string | null;
  loading: boolean;
  lastUpdated: Date | null;
}

/**
 * Client-side hook that provides weather data with IndexedDB caching
 * and automatic background refresh every minute (or on page visibility change).
 *
 * Flow:
 *   1. Check IndexedDB for cached data — render immediately if fresh
 *   2. Fetch from server API in background
 *   3. Store response in IndexedDB
 *   4. Re-fetch every 60s or when the tab becomes visible
 */
export function useWeatherSync(
  locationSlug: string,
  lat: number,
  lon: number,
) {
  const [state, setState] = useState<WeatherSyncState>({
    weather: null,
    aiInsight: null,
    loading: true,
    lastUpdated: null,
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const fetchWeatherFromServer = useCallback(async () => {
    try {
      const res = await fetch(`/api/weather?lat=${lat}&lon=${lon}`);
      if (!res.ok) return null;
      const data: WeatherData = await res.json();

      // Store in IndexedDB for offline/instant access
      await setWeatherInIDB(locationSlug, data);

      return data;
    } catch {
      return null;
    }
  }, [locationSlug, lat, lon]);

  const fetchAIFromServer = useCallback(async (weather: WeatherData) => {
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weatherData: {
            current: weather.current,
            daily: {
              temperature_2m_max: weather.daily.temperature_2m_max.slice(0, 3),
              temperature_2m_min: weather.daily.temperature_2m_min.slice(0, 3),
              weather_code: weather.daily.weather_code.slice(0, 3),
              precipitation_probability_max: weather.daily.precipitation_probability_max.slice(0, 3),
            },
          },
          location: { name: locationSlug, lat, lon },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();

      // Store AI summary in IndexedDB
      if (data.insight) {
        await setAISummaryInIDB(locationSlug, data.insight, data.generatedAt ?? new Date().toISOString());
      }

      return data.insight as string | null;
    } catch {
      return null;
    }
  }, [locationSlug, lat, lon]);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;

    try {
      // Try IndexedDB first for instant display
      const [cachedWeather, cachedAI] = await Promise.all([
        getWeatherFromIDB(locationSlug),
        getAISummaryFromIDB(locationSlug),
      ]);

      if (cachedWeather && mountedRef.current) {
        setState((prev) => ({
          ...prev,
          weather: cachedWeather,
          aiInsight: cachedAI?.insight ?? prev.aiInsight,
          loading: false,
          lastUpdated: new Date(),
        }));
      }

      // Always fetch fresh data from server in background
      const freshWeather = await fetchWeatherFromServer();
      if (freshWeather && mountedRef.current) {
        setState((prev) => ({
          ...prev,
          weather: freshWeather,
          loading: false,
          lastUpdated: new Date(),
        }));

        // Fetch AI in background (non-blocking)
        fetchAIFromServer(freshWeather).then((insight) => {
          if (insight && mountedRef.current) {
            setState((prev) => ({ ...prev, aiInsight: insight }));
          }
        });
      } else if (!cachedWeather && mountedRef.current) {
        setState((prev) => ({ ...prev, loading: false }));
      }
    } catch {
      // Storage or network failure — ensure loading state is cleared
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, loading: false }));
      }
    }
  }, [locationSlug, fetchWeatherFromServer, fetchAIFromServer]);

  // Initial load + interval refresh.
  // Uses setTimeout(0) to schedule the initial fetch as a callback
  // rather than calling setState synchronously within the effect body.
  useEffect(() => {
    mountedRef.current = true;

    const initialTimeout = setTimeout(refresh, 0);
    intervalRef.current = setInterval(refresh, REFRESH_INTERVAL_MS);

    // Refresh on visibility change (tab switch, app resume)
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      mountedRef.current = false;
      clearTimeout(initialTimeout);
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  return {
    weather: state.weather,
    aiInsight: state.aiInsight,
    loading: state.loading,
    lastUpdated: state.lastUpdated,
    refresh,
  };
}
