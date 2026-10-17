"use client";

import { useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { getDeviceId } from "@/lib/rxdb/bridge";
import { isStandalone } from "@/lib/device-info";
import { readDeviceState } from "@/lib/device-state";
import {
  DEVICE_SYNC_AT_KEY,
  syncDevice,
  type DeviceSyncDeps,
} from "@/lib/device-sync";
import { readStorage, removeStorage, writeStorage } from "@/lib/safe-storage";

function browserDeps(): DeviceSyncDeps {
  return {
    now: () => Date.now(),
    deviceId: getDeviceId,
    userAgent: navigator.userAgent,
    standalone: isStandalone(),
    state: readDeviceState,
    preferences: () => {
      const s = useAppStore.getState();
      return {
        theme: s.theme,
        selectedActivities: s.selectedActivities,
        savedLocations: s.savedLocations,
        selectedForecastModel: s.selectedForecastModel,
        homeLocation: s.homeLocation,
      };
    },
    readSyncedAt: () => {
      const n = Number(readStorage(DEVICE_SYNC_AT_KEY));
      return Number.isFinite(n) && n > 0 ? n : null;
    },
    writeSyncedAt: (at) => {
      writeStorage(DEVICE_SYNC_AT_KEY, String(at));
    },
    fetch: (url, init) => fetch(url, init),
  };
}

/**
 * Report this device to the signed-in person's account at most once an hour.
 * The first report after sign-in is the CLAIM: the device (anonymous local id,
 * local permission state and preferences) is registered to the person.
 * Does nothing when signed out: logged-out devices keep everything locally. Never blocks or throws: failure leaves the
 * device exactly as it was.
 */
export function useDeviceHeartbeat(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) {
      // Signed out: nothing is reported, and the "reported" mark is dropped
      // so the next sign-in (this person or another) claims the device at
      // once instead of waiting out the hour.
      removeStorage(DEVICE_SYNC_AT_KEY);
      return;
    }
    // After first paint, so it never competes with the weather.
    const id = window.setTimeout(() => {
      void syncDevice(browserDeps()).catch(() => undefined);
    }, 3000);
    return () => window.clearTimeout(id);
  }, [signedIn]);
}
