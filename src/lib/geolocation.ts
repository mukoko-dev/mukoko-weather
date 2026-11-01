"use client";

import type { WeatherLocation } from "./locations";
import { haversineKm } from "./geo";
import { fetchPlaces } from "./weather-api";

export interface GeoResult {
  status: "success" | "created" | "denied" | "unavailable" | "error";
  location: WeatherLocation | null;
  coords: { lat: number; lon: number } | null;
  distanceKm: number | null;
  /** True when the location was just auto-created via reverse geocoding */
  isNew?: boolean;
  /**
   * True when nothing is stored near the fix and the find-only lookup named
   * the spot on demand without storing it (`/v1/geo` `synthesized`,
   * #302). A GPS caller then asks again with `autoCreate` to store the place.
   */
  synthesized?: boolean;
  /**
   * True when nothing on Earth names the point (open water, polar ice, empty
   * desert): the location is a coordinate label, a spot that renders weather.
   * There is no better place to create, so the caller keeps it as is.
   */
  unnamed?: boolean;
  /**
   * True when naming the point was skipped (over budget, the geocoder down):
   * the location is a coordinate label, but that says nothing about the
   * point, unlike `unnamed`. See `src/lib/location-choice.ts`.
   */
  namingSkipped?: boolean;
}

/** Default GPS timeout — used for user-initiated lookups (first-visit auto-prompt, explicit "Use my current location"). */
const DEFAULT_TIMEOUT_MS = 10000;
/** Default browser position-cache window — 1 minute. */
const DEFAULT_MAXIMUM_AGE_MS = 60000;
/**
 * Cap on the /v1/geo round-trip after the fix arrives. Find-only is a
 * cheap DB read; create-on-demand reverse-geocodes (Overpass, then Nominatim)
 * so it gets longer. Without a cap, a hung lookup left the visitor on a
 * "Finding your location…" screen indefinitely.
 */
export const GEO_LOOKUP_TIMEOUT_MS = 8000;
export const GEO_CREATE_TIMEOUT_MS = 15000;

export interface DetectUserLocationOptions {
  /** If true, auto-creates a new location via reverse geocoding when
   *  none is found nearby. Default false — find nearest only, never create
   *  duplicates. Only pass true when the user explicitly wants to add their
   *  position to the DB (e.g. the "Use current location" flow in
   *  MyWeatherModal's Location tab). */
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
 * and snap to the nearest location via the Worker's /v1/geo endpoint.
 */
export function detectUserLocation({
  autoCreate = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maximumAgeMs = DEFAULT_MAXIMUM_AGE_MS,
}: DetectUserLocationOptions = {}): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({
        status: "unavailable",
        location: null,
        coords: null,
        distanceKm: null,
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;

        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          autoCreate ? GEO_CREATE_TIMEOUT_MS : GEO_LOOKUP_TIMEOUT_MS,
        );
        try {
          // The Rust Worker (weather-api.mukoko.com), one retry on a 5xx.
          const res = await fetchPlaces(
            "geo",
            `lat=${latitude}&lon=${longitude}${autoCreate ? "&autoCreate=true" : ""}`,
            { signal: controller.signal },
          );
          if (!res.ok) {
            resolve({
              status: "error",
              location: null,
              coords: { lat: latitude, lon: longitude },
              distanceKm: null,
            });
            return;
          }

          const data = await res.json();
          const nearest: WeatherLocation = data.nearest;
          const isNew: boolean = data.isNew ?? false;
          const synthesized = data.synthesized === true;
          const unnamed = data.nearest?.named === false;
          const namingSkipped = data.nearest?.namingSkipped === true;

          // Distance to the nearest location, for display
          const distanceKm = haversineKm(
            latitude,
            longitude,
            nearest.lat,
            nearest.lon,
          );

          resolve({
            status: isNew ? "created" : "success",
            location: nearest,
            coords: { lat: latitude, lon: longitude },
            distanceKm: Math.round(distanceKm),
            isNew,
            synthesized,
            unnamed,
            namingSkipped,
          });
        } catch {
          resolve({
            status: "error",
            location: null,
            coords: { lat: latitude, lon: longitude },
            distanceKm: null,
          });
        } finally {
          clearTimeout(timer);
        }
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          resolve({
            status: "denied",
            location: null,
            coords: null,
            distanceKm: null,
          });
        } else {
          resolve({
            status: "error",
            location: null,
            coords: null,
            distanceKm: null,
          });
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
