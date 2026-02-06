"use client";

import { findNearestLocation, type ZimbabweLocation } from "./locations";

export interface GeoResult {
  status: "success" | "denied" | "unavailable" | "outside-zw" | "error";
  location: ZimbabweLocation | null;
  coords: { lat: number; lon: number } | null;
  distanceKm: number | null;
}

/**
 * Request the user's position via the browser Geolocation API
 * and snap to the nearest Zimbabwe location.
 */
export function detectUserLocation(): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ status: "unavailable", location: null, coords: null, distanceKm: null });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const nearest = findNearestLocation(latitude, longitude);

        if (!nearest) {
          resolve({
            status: "outside-zw",
            location: null,
            coords: { lat: latitude, lon: longitude },
            distanceKm: null,
          });
          return;
        }

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
          status: "success",
          location: nearest,
          coords: { lat: latitude, lon: longitude },
          distanceKm: Math.round(distanceKm),
        });
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
        timeout: 10000,
        maximumAge: 300000, // cache for 5 minutes
      },
    );
  });
}
