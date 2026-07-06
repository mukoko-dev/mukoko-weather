"use client";

import type { WeatherLocation } from "./locations";

export interface GeoResult {
  status: "success" | "created" | "denied" | "unavailable" | "error";
  location: WeatherLocation | null;
  coords: { lat: number; lon: number } | null;
  distanceKm: number | null;
  /** True when the location was just auto-created via reverse geocoding */
  isNew?: boolean;
}

/** Default GPS timeout — used for user-initiated lookups (first-visit auto-prompt, explicit "Use my current location"). */
const DEFAULT_TIMEOUT_MS = 10000;
/** Default browser position-cache window — 1 minute. */
const DEFAULT_MAXIMUM_AGE_MS = 60000;

export interface DetectUserLocationOptions {
  /** If true, auto-creates a new location via reverse geocoding when
   *  none is found nearby. Default false — find nearest only, never create
   *  duplicates. Only pass true when the user explicitly wants to add their
   *  position to the DB (e.g. "Save my location" in SavedLocationsModal). */
  autoCreate?: boolean;
  /** Override the GPS timeout (ms). Defaults to 10s. A shorter value suits a
   *  background/silent recheck that must never visibly stall the UI. */
  timeoutMs?: number;
  /** Override the browser's cached-position window (ms). Defaults to 1 minute.
   *  A longer value lets a background recheck return near-instantly from an
   *  already-fresh on-device fix instead of forcing a brand-new GPS read. */
  maximumAgeMs?: number;
}

/**
 * Request the user's position via the browser Geolocation API
 * and snap to the nearest location via the /api/py/geo endpoint.
 */
export function detectUserLocation({
  autoCreate = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maximumAgeMs = DEFAULT_MAXIMUM_AGE_MS,
}: DetectUserLocationOptions = {}): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ status: "unavailable", location: null, coords: null, distanceKm: null });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;

        try {
          const res = await fetch(`/api/py/geo?lat=${latitude}&lon=${longitude}${autoCreate ? "&autoCreate=true" : ""}`);
          if (!res.ok) {
            resolve({ status: "error", location: null, coords: { lat: latitude, lon: longitude }, distanceKm: null });
            return;
          }

          const data = await res.json();
          const nearest: WeatherLocation = data.nearest;
          const isNew: boolean = data.isNew ?? false;

          // Calculate distance to nearest for display
          const R = 6371;
          const dLat = ((nearest.lat - latitude) * Math.PI) / 180;
          const dLon = ((nearest.lon - longitude) * Math.PI) / 180;
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((latitude * Math.PI) / 180) *
              Math.cos((nearest.lat * Math.PI) / 180) *
              Math.sin(dLon / 2) *
              Math.sin(dLon / 2);
          const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

          resolve({
            status: isNew ? "created" : "success",
            location: nearest,
            coords: { lat: latitude, lon: longitude },
            distanceKm: Math.round(distanceKm),
            isNew,
          });
        } catch {
          resolve({ status: "error", location: null, coords: { lat: latitude, lon: longitude }, distanceKm: null });
        }
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          resolve({ status: "denied", location: null, coords: null, distanceKm: null });
        } else {
          resolve({ status: "error", location: null, coords: null, distanceKm: null });
        }
      },
      {
        enableHighAccuracy: false,
        timeout: timeoutMs,
        maximumAge: maximumAgeMs,
      },
    );
  });
}
