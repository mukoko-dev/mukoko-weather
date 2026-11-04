/**
 * A signed-in person's activities and saved places: the contract.
 *
 * The owner's rule (2026-11-04): what a person chose follows the PERSON, not
 * the device. This module is the wire contract of `GET` and `PUT
 * /api/profile/preferences` and the rules both sides share (the route that
 * validates and the browser that merges). It touches no storage and no
 * network, so it is safe on the server and in the browser and is tested in
 * node.
 *
 * SHAPE. The JSON is the one nyuchi/nyuchi-api#483 asks the platform for
 * (`schemaVersion`, `settings`, `activities`, `savedPlaces`, `updatedAt`; a
 * request is any subset, an item is merged on its own, the later `updatedAt`
 * wins, a removal is a tombstone), so the route can later become a thin
 * forward to that API with no client change. Where #483 and the data-infra
 * model (`schemas/model/userdb.yaml`, ADR-0002) name a field differently, this
 * module follows the model, because the person's CouchDB database is where the
 * truth moves: an activity is `activityId` (not `id`), a removal is
 * `tombstone` (CouchDB's `_deleted`; not `deleted`). Those two differences are
 * the only ones for activities.
 *
 * SAVED PLACES ARE CIPHERTEXT. ADR-0002 decided that the places a person keeps
 * reveal where they live, so they are encrypted on the device. A saved place
 * here is therefore the `savedPlace` document exactly as the model replicates
 * it: `savedPlaceId` (the UUIDv7 in `savedPlace:<UUIDv7>`), the common fields,
 * and an `envelope`, a JWE in the flattened JSON serialization. The server
 * never sees `placeKey`, `position` or `name`; they are inside the envelope.
 * #483 asks for a readable catalogue slug in this slot; that difference is an
 * open owner question (see the PR), and it is why saved places have their own
 * switch (`PERSON_SAVED_PLACES_READY`, in `person-preferences-switches.ts`) and
 * why no client writes one yet: the key that would encrypt them has no home
 * (ADR-0002 open item).
 *
 * THE SWITCHES are in `person-preferences-switches.ts`: nothing is written until
 * nyuchi has applied the `identity.persons` validator change.
 */

import { getActivityById } from "./activities";

/** `schemaVersion` of the document, as `userdb.yaml` and #483 write it. */
export const PERSON_PREFERENCES_SCHEMA_VERSION = "v3.1";

/** Live activities a person can keep (tombstones do not count). */
export const MAX_PERSON_ACTIVITIES = 20;
/** Live saved places (the same number as `MAX_SAVED_LOCATIONS` in `store.ts`). */
export const MAX_PERSON_SAVED_PLACES = 10;
/**
 * Bounds on what is STORED, tombstones included, so a person's record cannot
 * grow without end. Activities are limited to the catalogue anyway; saved
 * places are not, because their id is a random UUID inside an envelope.
 */
export const MAX_STORED_ACTIVITIES = 100;
export const MAX_STORED_SAVED_PLACES = 30;
/** Items in one request. */
export const MAX_ITEMS_PER_REQUEST = 100;
/** A request body, in bytes (#483: 16 KiB). */
export const MAX_BODY_BYTES = 16 * 1024;
/** A tombstone older than this is dropped on the next write (#483: 30 days). */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** An `updatedAt` further ahead of the server's clock is refused (CouchDB's rule). */
export const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;
/**
 * The longest ciphertext (base64url characters) this interim home keeps per
 * saved place. The model allows 32768; the payload is a place key, a position
 * and a label of at most 80 characters, which is a few hundred, and the person
 * record is read on every profile view, so it stays small.
 */
export const MAX_ENVELOPE_CIPHERTEXT = 1024;

/** An RFC 3339 UTC time with exactly three fraction digits (`UtcTimestamp`). */
const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** `activityId` in `userdb.yaml`. */
export const ACTIVITY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The key of `savedPlace:<UUIDv7>`. */
export const SAVED_PLACE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** What every item carries so two devices can merge it on its own. */
export interface Versioned {
  /** RFC 3339 UTC, three fraction digits. Kept from the first write. */
  createdAt: string;
  /** RFC 3339 UTC, three fraction digits. The later one wins. */
  updatedAt: string;
  /** A removal. Kept for 30 days so another device learns of it. */
  tombstone: boolean;
}

/** `activity:<activityId>`, plaintext. */
export interface ActivityItem extends Versioned {
  activityId: string;
}

/** A JWE (RFC 7516), flattened JSON serialization, the ADR-0002 profile. */
export interface Envelope {
  protected: string;
  aad: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

/** `savedPlace:<UUIDv7>`: the common fields and an envelope (none on a tombstone). */
export interface SavedPlaceItem extends Versioned {
  savedPlaceId: string;
  envelope?: Envelope;
}

export interface PersonPreferences {
  schemaVersion: typeof PERSON_PREFERENCES_SCHEMA_VERSION;
  /** Settings (theme, forecast model) are not stored by this route yet. */
  settings: Record<string, never>;
  activities: ActivityItem[];
  savedPlaces: SavedPlaceItem[];
  /** The latest `updatedAt` of any item; absent for a person with nothing. */
  updatedAt?: string;
}

/** What a request may carry: any subset of the lists. */
export interface PersonPreferencesPatch {
  activities: ActivityItem[];
  savedPlaces: SavedPlaceItem[];
}

/** A refusal, as the route turns it into an RFC 9457 problem. */
export interface Problem {
  status: number;
  /** A stable machine code (`too_many_activities`). */
  code: string;
}

export type ParseResult =
  | { ok: true; patch: PersonPreferencesPatch }
  | { ok: false; problem: Problem };

const refuse = (
  status: number,
  code: string,
): { ok: false; problem: Problem } => ({
  ok: false,
  problem: { status, code },
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every key of `obj` is in `allowed`. */
function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function utcTimestamp(v: unknown): string | null {
  if (typeof v !== "string" || !UTC_TIMESTAMP_RE.test(v)) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

function base64urlOfAscii(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64urlJson(text: string): unknown {
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)));
  } catch {
    return null;
  }
}

/**
 * The envelope, held to the ADR-0002 profile as far as a server that cannot
 * read it can: the five members and nothing else, their forms, a protected
 * header of exactly `alg: dir`, `enc: A256GCM` and a `kid`, and an `aad` that
 * names this document, so a ciphertext cannot be moved to another one.
 */
export function parseEnvelope(
  v: unknown,
  savedPlaceId: string,
): Envelope | null {
  if (!isRecord(v)) return null;
  const keys = ["protected", "aad", "iv", "ciphertext", "tag"];
  if (!onlyKeys(v, keys) || !keys.every((k) => typeof v[k] === "string")) {
    return null;
  }
  const e = v as Record<string, string>;
  const inRange = (s: string, min: number, max: number) =>
    BASE64URL_RE.test(s) && s.length >= min && s.length <= max;
  if (!inRange(e.protected, 52, 200)) return null;
  if (!inRange(e.aad, 1, 320)) return null;
  if (!/^[A-Za-z0-9_-]{16}$/.test(e.iv)) return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(e.tag)) return null;
  if (!inRange(e.ciphertext, 3, MAX_ENVELOPE_CIPHERTEXT)) return null;
  if (e.aad !== base64urlOfAscii(`savedPlace:${savedPlaceId}`)) return null;
  const header = decodeBase64urlJson(e.protected);
  if (!isRecord(header) || !onlyKeys(header, ["alg", "enc", "kid"]))
    return null;
  if (header.alg !== "dir" || header.enc !== "A256GCM") return null;
  if (typeof header.kid !== "string" || !KID_RE.test(header.kid)) return null;
  return {
    protected: e.protected,
    aad: e.aad,
    iv: e.iv,
    ciphertext: e.ciphertext,
    tag: e.tag,
  };
}

/** The fields every item has, checked; or the refusal. */
function parseVersioned(
  item: Record<string, unknown>,
  nowMs: number,
  code: string,
): Versioned | { problem: Problem } {
  const createdAt = utcTimestamp(item.createdAt);
  const updatedAt = utcTimestamp(item.updatedAt);
  const tombstone = item.tombstone === undefined ? false : item.tombstone;
  if (!createdAt || !updatedAt || typeof tombstone !== "boolean") {
    return { problem: { status: 422, code } };
  }
  if (Date.parse(updatedAt) > nowMs + MAX_CLOCK_AHEAD_MS) {
    return { problem: { status: 422, code: "updated_at_in_future" } };
  }
  if (createdAt > updatedAt) return { problem: { status: 422, code } };
  return { createdAt, updatedAt, tombstone };
}

/**
 * Check a request body. Strict: an unknown field, a wrong type, a duplicate
 * item, an activity that is not in the catalogue, a malformed envelope or a
 * time more than a day ahead is refused and nothing is applied. Every refusal
 * is a fixed code; no value from the body is echoed back.
 */
export function parsePatch(body: unknown, nowMs: number): ParseResult {
  if (!isRecord(body)) return refuse(400, "invalid_body");
  if (
    !onlyKeys(body, [
      "schemaVersion",
      "settings",
      "activities",
      "savedPlaces",
      "updatedAt",
    ])
  ) {
    return refuse(422, "unknown_field");
  }
  if (
    body.schemaVersion !== undefined &&
    body.schemaVersion !== PERSON_PREFERENCES_SCHEMA_VERSION
  ) {
    return refuse(422, "schema_version_not_supported");
  }
  if (body.updatedAt !== undefined && !utcTimestamp(body.updatedAt)) {
    return refuse(422, "invalid_body");
  }
  if (body.settings !== undefined) {
    if (!isRecord(body.settings)) return refuse(422, "invalid_body");
    if (Object.keys(body.settings).length > 0) {
      return refuse(422, "settings_not_supported");
    }
  }

  const activities: ActivityItem[] = [];
  if (body.activities !== undefined) {
    if (!Array.isArray(body.activities)) return refuse(422, "invalid_activity");
    if (body.activities.length > MAX_ITEMS_PER_REQUEST) {
      return refuse(422, "too_many_activities");
    }
    const seen = new Set<string>();
    for (const raw of body.activities) {
      if (
        !isRecord(raw) ||
        !onlyKeys(raw, ["activityId", "createdAt", "updatedAt", "tombstone"])
      ) {
        return refuse(422, "invalid_activity");
      }
      const id = raw.activityId;
      if (typeof id !== "string" || !ACTIVITY_ID_RE.test(id)) {
        return refuse(422, "invalid_activity");
      }
      if (!getActivityById(id)) return refuse(422, "activity_not_allowed");
      if (seen.has(id)) return refuse(422, "duplicate_item");
      seen.add(id);
      const common = parseVersioned(raw, nowMs, "invalid_activity");
      if ("problem" in common) return { ok: false, problem: common.problem };
      activities.push({ activityId: id, ...common });
    }
  }

  const savedPlaces: SavedPlaceItem[] = [];
  if (body.savedPlaces !== undefined) {
    if (!Array.isArray(body.savedPlaces)) {
      return refuse(422, "invalid_saved_place");
    }
    if (body.savedPlaces.length > MAX_ITEMS_PER_REQUEST) {
      return refuse(422, "too_many_places");
    }
    const seen = new Set<string>();
    for (const raw of body.savedPlaces) {
      if (
        !isRecord(raw) ||
        !onlyKeys(raw, [
          "savedPlaceId",
          "createdAt",
          "updatedAt",
          "tombstone",
          "envelope",
        ])
      ) {
        return refuse(422, "invalid_saved_place");
      }
      const id = raw.savedPlaceId;
      if (typeof id !== "string" || !SAVED_PLACE_ID_RE.test(id)) {
        return refuse(422, "invalid_saved_place");
      }
      if (seen.has(id)) return refuse(422, "duplicate_item");
      seen.add(id);
      const common = parseVersioned(raw, nowMs, "invalid_saved_place");
      if ("problem" in common) return { ok: false, problem: common.problem };
      if (common.tombstone) {
        // A tombstone keeps the common fields and drops the rest.
        if (raw.envelope !== undefined) {
          return refuse(422, "invalid_saved_place");
        }
        savedPlaces.push({ savedPlaceId: id, ...common });
        continue;
      }
      const envelope = parseEnvelope(raw.envelope, id);
      if (!envelope) return refuse(422, "invalid_saved_place");
      savedPlaces.push({ savedPlaceId: id, ...common, envelope });
    }
  }

  return { ok: true, patch: { activities, savedPlaces } };
}

// ---------------------------------------------------------------------------
// Merge: per item, last writer wins (the rule of ADR-0002 section 4)
// ---------------------------------------------------------------------------

/**
 * One item against what is stored for it. The later `updatedAt` wins; on a tie
 * the stored item stays; `createdAt` is kept from the first write. A tombstone
 * is an item like any other: a later live write revives it, an earlier one
 * does not. RFC 3339 with three fraction digits compares as text.
 */
export function mergeItem<T extends Versioned>(
  stored: T | undefined,
  incoming: T,
): T {
  if (!stored) return incoming;
  if (incoming.updatedAt > stored.updatedAt) {
    return { ...incoming, createdAt: stored.createdAt };
  }
  return stored;
}

function compareBy<T extends Versioned>(idOf: (t: T) => string) {
  return (a: T, b: T) =>
    a.createdAt < b.createdAt
      ? -1
      : a.createdAt > b.createdAt
        ? 1
        : idOf(a) < idOf(b)
          ? -1
          : idOf(a) > idOf(b)
            ? 1
            : 0;
}

/** Merge two lists item by item. Ordered by `createdAt`, then id. */
export function mergeById<T extends Versioned>(
  stored: readonly T[],
  incoming: readonly T[],
  idOf: (t: T) => string,
): T[] {
  const byId = new Map<string, T>();
  for (const item of stored) byId.set(idOf(item), item);
  for (const item of incoming) {
    byId.set(idOf(item), mergeItem(byId.get(idOf(item)), item));
  }
  return [...byId.values()].sort(compareBy(idOf));
}

export const activityIdOf = (a: ActivityItem) => a.activityId;
export const savedPlaceIdOf = (p: SavedPlaceItem) => p.savedPlaceId;

export function liveCount(items: readonly Versioned[]): number {
  return items.filter((i) => !i.tombstone).length;
}

/**
 * The cap a merge would break, or null. A merge that leaves a list over its
 * cap is refused only when it adds to it: a person already over (a cap that
 * was lowered) can still remove things.
 */
export function capProblem(
  stored: { activities: ActivityItem[]; savedPlaces: SavedPlaceItem[] },
  merged: { activities: ActivityItem[]; savedPlaces: SavedPlaceItem[] },
): Problem | null {
  const grows = (before: Versioned[], after: Versioned[], cap: number) =>
    liveCount(after) > cap && liveCount(after) > liveCount(before);
  if (
    merged.activities.length > MAX_STORED_ACTIVITIES ||
    grows(stored.activities, merged.activities, MAX_PERSON_ACTIVITIES)
  ) {
    return { status: 422, code: "too_many_activities" };
  }
  if (
    merged.savedPlaces.length > MAX_STORED_SAVED_PLACES ||
    grows(stored.savedPlaces, merged.savedPlaces, MAX_PERSON_SAVED_PLACES)
  ) {
    return { status: 422, code: "too_many_places" };
  }
  return null;
}

/** The response document for what is stored. */
export function toDocument(
  activities: readonly ActivityItem[],
  savedPlaces: readonly SavedPlaceItem[],
): PersonPreferences {
  const acts = [...activities].sort(compareBy(activityIdOf));
  const places = [...savedPlaces].sort(compareBy(savedPlaceIdOf));
  let latest = "";
  for (const item of [...acts, ...places]) {
    if (item.updatedAt > latest) latest = item.updatedAt;
  }
  return {
    schemaVersion: PERSON_PREFERENCES_SCHEMA_VERSION,
    settings: {},
    activities: acts,
    savedPlaces: places,
    ...(latest ? { updatedAt: latest } : {}),
  };
}

/** `Date` to the wire form (RFC 3339 UTC, three fraction digits). */
export function toWireTime(date: Date): string {
  return date.toISOString();
}
