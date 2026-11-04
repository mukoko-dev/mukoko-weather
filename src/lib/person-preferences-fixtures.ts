/**
 * Shared fixtures for the person-preferences tests. Not imported by the app.
 */

import type { ActivityItem, SavedPlaceItem } from "./person-preferences";
import { ACTIVITIES } from "./activities";

export const T1 = "2026-11-04T09:00:00.000Z";
export const T2 = "2026-11-04T10:00:00.000Z";
export const T3 = "2026-11-04T11:00:00.000Z";
export const ACT = ACTIVITIES[0].id;
export const ACT2 = ACTIVITIES[1].id;
export const ACT3 = ACTIVITIES[2].id;
export const PLACE_ID = "01934f6a-7b2c-7d3e-8a4f-5b6c7d8e9f01";

export const b64url = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A well-formed envelope of the ADR-0002 profile for `savedPlace:<id>`. */
export function envelopeFor(
  id = PLACE_ID,
  header: Record<string, unknown> = {},
) {
  return {
    protected: b64url(
      JSON.stringify({ alg: "dir", enc: "A256GCM", kid: "key-1", ...header }),
    ),
    aad: b64url(`savedPlace:${id}`),
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "QUJDREVGR0hJSktMTU5PUA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA",
  };
}

export const activity = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  activityId: ACT,
  createdAt: T1,
  updatedAt: T1,
  tombstone: false,
  ...over,
});

export const place = (over: Partial<SavedPlaceItem> = {}): SavedPlaceItem => ({
  savedPlaceId: PLACE_ID,
  createdAt: T1,
  updatedAt: T1,
  tombstone: false,
  envelope: envelopeFor(),
  ...over,
});

/** The nth distinct UUIDv7-shaped place id. */
export const placeId = (n: number) =>
  `01934f6a-7b2c-7d3e-8a4f-${String(n).padStart(12, "0")}`;

/** `obj` without `key` (for tests of a field that is absent). */
export function without<T extends object, K extends keyof T>(
  obj: T,
  key: K,
): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}
