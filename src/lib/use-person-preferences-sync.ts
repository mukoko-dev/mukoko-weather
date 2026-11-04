"use client";

/**
 * Starts the person-preferences sync for a signed-in person
 * (`person-preferences-sync-start.ts`), or does nothing.
 *
 * Nothing unless the person is signed in AND the platform is ready
 * (`PERSON_PREFERENCES_READY`): with the switch off, no request is made, no
 * storage key is written and the sync code is never fetched. The sync itself
 * is a dynamic import, so it is not in the first-load JavaScript of any page.
 * Never throws into the app and never blocks a render.
 */

import { useEffect } from "react";
import { PERSON_PREFERENCES_READY } from "./person-preferences-switches";

export function usePersonPreferencesSync(ownerId: string | null): void {
  useEffect(() => {
    if (!PERSON_PREFERENCES_READY || !ownerId) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    void import("./person-preferences-sync-start")
      .then((m) => {
        if (disposed) return;
        stop = m.startPersonPreferencesSync(ownerId);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [ownerId]);
}
