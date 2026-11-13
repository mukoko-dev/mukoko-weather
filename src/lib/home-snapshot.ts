/**
 * The last forecast shown for My Location, kept in localStorage so the next
 * open can paint it at once, before IndexedDB (RxDB) has started.
 *
 * Why a second copy: the place and its weather are stored in RxDB
 * (`weather_places`, src/lib/rxdb/weather-places.ts), but RxDB and its storage
 * adapter are about 350 KB of JavaScript that loads after the page hydrates,
 * and the first render waited for it (up to the place controller's recall
 * timeout) before showing a stored place. localStorage is one synchronous read.
 *
 * What is kept: ONE place, the one `/` last showed, in the same slim form
 * RxDB stores (`serialisePayload`: the real forecast without the comparison
 * series and the nowcast, and never the seasonal estimate), under one key, at
 * most `HOME_SNAPSHOT_MAX_BYTES`. Nothing else, so the key cannot grow.
 *
 * Privacy (the owner's rules): it is only on this device. It is never in the
 * page HTML, so the service worker and any CDN cannot keep it, and nothing here
 * is sent anywhere. It is the same data, about the same place, that RxDB
 * already holds on the device, and it is read back through the same validation
 * and re-basing (`parsePayload`, `deviceViewOf`), so a copy that is corrupt or
 * whose forecast has run out is dropped, never shown. Like the stored places
 * it is per device, not per person (signing out does not clear either), and it
 * goes where they go: `clearPlaces` forgets it, and `rememberPlace` keeps it
 * from falling behind the stored copy of the same place.
 */
import {
  deviceViewOf,
  parsePayload,
  serialisePayload,
  servedStaleAgeMs,
  type DashboardPayload,
  type DeviceView,
} from "./device-weather";
import { readStorage, removeStorage, writeStorage } from "./safe-storage";
import { canonicalSlug } from "./slug-migration";

export const HOME_SNAPSHOT_KEY = "mukoko-home-snapshot";

/** Bumped when the stored shape changes: an older copy is then ignored. */
export const HOME_SNAPSHOT_VERSION = 1;

/**
 * Largest copy kept (characters of the stored value). A slim forecast is about
 * 15 to 35 KB; one over this stays in IndexedDB only, and localStorage's
 * 5 MB per site is never put at risk.
 */
export const HOME_SNAPSHOT_MAX_BYTES = 100_000;

interface Snapshot {
  v: number;
  /** The canonical slug of the place. */
  slug: string;
  /** When the forecast came off the network (epoch ms). */
  fetchedAt: number;
  /** The slim payload, as `serialisePayload` makes it. */
  payload: string;
}

/** When the forecast held for `slug` came off the network, or 0 when none is. */
function heldFetchedAt(slug: string): number {
  const raw = readStorage(HOME_SNAPSHOT_KEY);
  if (!raw) return 0;
  try {
    const held = JSON.parse(raw) as Partial<Snapshot>;
    return held.v === HOME_SNAPSHOT_VERSION &&
      held.slug === slug &&
      typeof held.fetchedAt === "number"
      ? held.fetchedAt
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Keep `payload` (the place `/` shows, with its forecast) for the next open.
 * `fetchedAt` is when the forecast came off the network; omit it for a
 * forecast just fetched (a forecast the Worker served stale keeps the age it
 * had, as in `rememberPlace`). Nothing is written when a copy of this place
 * that is as new, or newer, is already held (another tab may have kept one),
 * so the same forecast is never written twice and a newer one is never
 * replaced by an older one. With `onlyIfHeld` it only refreshes a copy of this
 * place that exists (the stored place was updated elsewhere), never makes one.
 * Returns true when a copy of this place and forecast, or a newer one, is held.
 * Never throws.
 */
export function rememberHomeSnapshot(
  payload: DashboardPayload,
  fetchedAt?: number,
  now: number = Date.now(),
  opts: { onlyIfHeld?: boolean } = {},
): boolean {
  if (!payload?.location?.slug) return false;
  const slug = canonicalSlug(payload.location.slug);
  const at = Math.round(
    fetchedAt ?? now - (servedStaleAgeMs(payload.weather) ?? 0),
  );
  const held = heldFetchedAt(slug);
  if (held > 0 && held >= at) return true;
  if (opts.onlyIfHeld && held === 0) return false;
  const serialised = serialisePayload(payload);
  if (!serialised) return false;
  const value = JSON.stringify({
    v: HOME_SNAPSHOT_VERSION,
    slug,
    fetchedAt: at,
    payload: serialised.json,
  } satisfies Snapshot);
  if (value.length > HOME_SNAPSHOT_MAX_BYTES) {
    // Too large to keep here (it is still in IndexedDB): do not leave the
    // previous copy behind as if it were this one's.
    forgetHomeSnapshot();
    return false;
  }
  if (!writeStorage(HOME_SNAPSHOT_KEY, value)) {
    // Storage is full or blocked: an older copy would then be the last word.
    forgetHomeSnapshot();
    return false;
  }
  return true;
}

/**
 * The copy for `slug`, ready to render and re-based on `now`, or null when
 * there is none for that place, it is unreadable, or its forecast has run out
 * (a copy that cannot be shown is removed).
 */
export function recallHomeSnapshot(
  slug: string,
  now: number = Date.now(),
): DeviceView | null {
  if (!slug) return null;
  const raw = readStorage(HOME_SNAPSHOT_KEY);
  if (!raw) return null;
  let snap: Partial<Snapshot> | null = null;
  try {
    snap = JSON.parse(raw) as Partial<Snapshot>;
  } catch {
    snap = null;
  }
  if (
    !snap ||
    snap.v !== HOME_SNAPSHOT_VERSION ||
    typeof snap.slug !== "string" ||
    typeof snap.fetchedAt !== "number"
  ) {
    forgetHomeSnapshot();
    return null;
  }
  // Another place is not this one's copy, and is kept for when it is asked for.
  if (snap.slug !== canonicalSlug(slug)) return null;
  const payload = parsePayload(snap.payload);
  const view = payload
    ? deviceViewOf({ payload, fetchedAt: snap.fetchedAt }, now)
    : null;
  if (!view) {
    forgetHomeSnapshot();
    return null;
  }
  return view;
}

/** Drop the copy (it is corrupt or out of date, or the device is being cleared). */
export function forgetHomeSnapshot(): void {
  removeStorage(HOME_SNAPSHOT_KEY);
}
