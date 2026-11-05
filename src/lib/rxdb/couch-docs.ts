/**
 * CouchDB documents for a person's own database (`user_<personId>`): the
 * plaintext types only (mukoko-dev/mukoko-weather#396, web slice).
 *
 * Pure: no I/O, no clock, no RxDB. Everything the sync engine decides about
 * WHAT is written lives here, so it is tested without a database.
 *
 * WHAT SYNCS. Exactly two document types, both plaintext by the data model
 * (nyuchi/data-infra `schemas/model/userdb.yaml`, ADR-0002):
 *
 *   - `activity:<activityId>`   an activity the person selected for advice
 *   - `preference:<key>`        one non-locational setting: `theme` and
 *                               `forecastModel`
 *
 * WHAT NEVER SYNCS FROM HERE. Saved places, the home place, history,
 * interests, engagement and device notes are ciphertext envelopes whose keys
 * are held on the device; the key-custody design is not decided, so this
 * slice writes none of them and never writes anything locational in
 * plaintext. `assertPlaintextDoc` is the last gate before a document leaves
 * the device, and the engine's fetch layer drops every other document id on
 * the way in, so a type this client does not own is neither stored nor
 * pushed.
 *
 * THE DOCUMENT SHAPE IS THE VALIDATOR'S. nyuchi-api installs data-infra's
 * GENERATED `validate_doc_update` (from `schemas/model/userdb.yaml`, ADR-0002)
 * as `_design/user` in every person's database
 * (`gateway/lib/couch_validate_personal.js`, `couch_documents.py`). A copy is
 * pinned in `__fixtures__/couch_validate_personal.fn.txt` (its header names the
 * commit and the day it was read) and the tests EXECUTE it on every document
 * this client writes. What it requires, and so what this file builds:
 *
 *   every document   `_id`, `schemaVersion` (a string `^v[0-9]+\.[0-9]+$`; we
 *                    write `v3.1`), `type` (the part of `_id` before the colon),
 *                    `deviceId` (a lower-case UUID), `createdAt`, `updatedAt`
 *                    (exactly `YYYY-MM-DDTHH:mm:ss.SSSZ`, and `updatedAt` not
 *                    more than a day ahead of the SERVER's clock); no other
 *                    field. There is no `ownerPersonId`: the database name is
 *                    the ownership.
 *   preference       `_id` `preference:<key>`, plaintext `preferenceKey` (equal
 *                    to the key in `_id`) and `preferenceValue` (a string, with
 *                    the rule of the key: `theme` light|dark|system,
 *                    `forecastModel` one of the validator's ten ids), no envelope
 *   activity         `_id` `activity:<id>`, `activityId` equal to it
 *   tombstone        `_deleted: true` WITH the common fields (`type`,
 *                    `schemaVersion`, `deviceId`, `createdAt`, `updatedAt`) and
 *                    nothing else: no `activityId`, no `preferenceKey`, no
 *                    `preferenceValue`, no envelope. A bare `{_id, _rev,
 *                    _deleted}` is refused.
 *
 * A write the validator refuses delays everything pushed with it, so nothing
 * here is written that the pinned validator does not accept, and a value it
 * does not list stays on the device (see `SYNCED_FORECAST_MODELS`).
 *
 * CONFLICTS. The rule of docs/architecture/couchdb-documents.md (nyuchi-api):
 * the revision with the later `updatedAt` wins; on an equal `updatedAt` the
 * revision CouchDB chose (the master) stays. A tombstone carries `updatedAt`
 * like any other revision, so a delete and an edit are ordered by it, and an
 * activity picked again after another device removed it wins when it is the
 * later write.
 */

import { ACTIVITIES } from "../activities";
import { ForecastModel } from "../weather";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The `schemaVersion` written into every document: the model version
 * (data-infra `userdb.yaml`, `schema_versions_accepted: v3.1`). The validator
 * accepts any `^v[0-9]+\.[0-9]+$`.
 */
export const COUCH_DOC_SCHEMA_VERSION = "v3.1";

/**
 * A `schemaVersion` this client understands when it READS a document: the
 * same major version (an additive minor version changes nothing it uses).
 */
const READABLE_SCHEMA_VERSION_RE = /^v3\.[0-9]+$/;

export const THEME_VALUES = ["light", "dark", "system"] as const;
export type ThemeValue = (typeof THEME_VALUES)[number];

/**
 * The `forecastModel` values this app SYNCS: the ids the validator's enum lists
 * (`couch_validate_personal.js`: best_match, ecmwf_ifs, ecmwf_aifs025_single,
 * gfs_seamless, icon_global, ukmo_global_deterministic_10km, cma_grapes_global,
 * gem_global, meteofrance_arpege_world, jma_gsm) that this app also offers (its
 * picker, `ForecastModel` in `weather.ts`). `couch-docs.test.ts` derives the
 * expected list from the pinned validator and fails when this one differs, so a
 * model added to either side is a decision, not an accident.
 *
 * Not synced, by design:
 *   - `meteofrance_seamless`, which the picker offers and the validator's enum
 *     does not list. A document for it is REFUSED, and a refused document
 *     delays everything pushed with it, so that pick stays on the device
 *     (`LOCAL_ONLY_FORECAST_MODELS`): it is never written, and a document from
 *     another device never replaces it;
 *   - `apple_weatherkit` (Apple Weather, behind `FLAGS.apple_weatherkit`), for
 *     the same reason: it is another provider's model, the validator's enum
 *     (the gateway's) has no such id, so it is local-only whether or not the
 *     picker offers it. It joins `LOCAL_ONLY_FORECAST_MODELS` through
 *     `ForecastModel`, so nothing here has to list it;
 *   - the ids the validator lists that this app cannot show (`jma_gsm`,
 *     `ukmo_global_deterministic_10km`, `cma_grapes_global`, `gem_global`,
 *     `meteofrance_arpege_world`): a pick another client made with one of them
 *     is ignored, never applied, and never replaces what the person chose here.
 *
 * Every synced value is in the Worker's device-profile allowlist
 * (`FORECAST_MODELS` in `weather_core::community`, 12 ids, a different list from
 * the validator's 10), so a synced pick cannot make `/v1/devices` answer 400.
 */
export const SYNCED_FORECAST_MODELS = [
  "best_match",
  "ecmwf_ifs",
  "ecmwf_aifs025_single",
  "gfs_seamless",
  "icon_global",
] as const;
export type ForecastModelValue = (typeof SYNCED_FORECAST_MODELS)[number];

/** The app's own picks that the validator does not list: they stay on the device. */
export const LOCAL_ONLY_FORECAST_MODELS: readonly string[] = Object.values(
  ForecastModel,
).filter((m) => !(SYNCED_FORECAST_MODELS as readonly string[]).includes(m));

/** The setting keys this client reads and writes. */
export const SYNCED_PREFERENCE_KEYS = ["theme", "forecastModel"] as const;
export type SyncedPreferenceKey = (typeof SYNCED_PREFERENCE_KEYS)[number];

/** Defaults: a value equal to its default is not worth seeding. */
export const DEFAULT_THEME: ThemeValue = "system";
export const DEFAULT_FORECAST_MODEL: ForecastModelValue = "best_match";

/** `activity:<activityId>`; the id pattern of the data model. */
export const ACTIVITY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OWNED_ID_RE = new RegExp(
  `^(?:activity:[a-z0-9][a-z0-9-]{0,63}|preference:(?:${SYNCED_PREFERENCE_KEYS.join("|")}))$`,
);
const RFC3339_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A time in the one form the data model requires (`…SSS Z`) that is also a
 * real instant. The pattern alone passes `2026-02-30T…`, which `Date` rolls
 * forward to 2 March, so the string is also required to be exactly what the
 * instant it names prints as.
 */
export function isWireTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || !RFC3339_MS_RE.test(v)) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A document as RxDB stores it: the CouchDB `_id` is the `id` field. */
export interface UserDocType {
  id: string;
  type: "preference" | "activity";
  /** `v3.1` (`COUCH_DOC_SCHEMA_VERSION`): a string, not a number. */
  schemaVersion: string;
  /** The install that wrote it (a lower-case UUID, data-infra `deviceId`). */
  deviceId: string;
  createdAt: string;
  updatedAt: string;
  preferenceKey?: SyncedPreferenceKey;
  preferenceValue?: string;
  activityId?: string;
}

/** The slice of the app's state that this client syncs. */
export interface SyncableState {
  theme: string;
  selectedForecastModel: string;
  selectedActivities: string[];
}

/** What a set of documents says about that state; absent = no document. */
export type SyncedPatch = Partial<SyncableState>;

export interface DocContext {
  /** The install writing (a lower-case UUID). */
  deviceId: string;
  nowMs: number;
}

export type LocalDocOp =
  | { kind: "upsert"; doc: UserDocType }
  | { kind: "tombstone"; id: string };

// ---------------------------------------------------------------------------
// Ids, times and validation
// ---------------------------------------------------------------------------

export const preferenceDocId = (key: SyncedPreferenceKey): string =>
  `preference:${key}`;
export const activityDocId = (activityId: string): string =>
  `activity:${activityId}`;

/** An id this client owns (stores, pushes, applies); everything else is foreign. */
export function isOwnedDocId(id: unknown): id is string {
  return typeof id === "string" && OWNED_ID_RE.test(id);
}

/**
 * Every id this client can have a document for: the two settings and one per
 * activity the app offers. Short, fixed and derived from the app's own
 * vocabulary, so the list the changes feed is filtered by (`filter=_doc_ids`,
 * `couch-fetch.ts`) is bounded whatever is in the database: documents other
 * clients keep there are never listed, never counted against a page of the pull
 * and never able to hold it up.
 */
export function ownedDocIds(): string[] {
  return [
    ...SYNCED_PREFERENCE_KEYS.map(preferenceDocId),
    ...ACTIVITIES.map((a) => activityDocId(a.id)),
  ];
}

/** The CouchDB wire form of a time: always three fractional digits, UTC. */
export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Any RFC 3339 time (fractional digits of any length or none, `Z` or a
 * `+hh:mm` / `-hh:mm` offset), not only the one form the validator requires of
 * what is WRITTEN today (`RFC3339_MS_RE`). What this client reads may have
 * been written under another rule (an older revision, a document the gateway
 * seeded, a client that predates the current model), so reading is lenient and
 * writing is not.
 */
const RFC3339_ANY_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A time as an instant in milliseconds, or null when it is not RFC 3339 or not
 * a real date. Times are compared as instants and never as text: as text
 * `…00.500Z` sorts before `…00Z`, and `12:00:00+02:00` (10:00 UTC) after
 * `10:30:00Z`, so another client's choice of form would decide who wins a
 * conflict. Fractional digits beyond a millisecond are cut (this client writes
 * milliseconds; the tie that cutting can make is the server's to keep).
 */
export function instantMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = RFC3339_ANY_RE.exec(value);
  if (!m) return null;
  const fraction = (m[2] ?? "").slice(0, 3).padEnd(3, "0");
  const ms = Date.parse(`${m[1]}.${fraction}${m[3]}`);
  return Number.isFinite(ms) ? ms : null;
}

export function isThemeValue(v: unknown): v is ThemeValue {
  return (THEME_VALUES as readonly unknown[]).includes(v);
}

/** A forecast model that is synced (listed by the validator and offered here). */
export function isForecastModelValue(v: unknown): v is ForecastModelValue {
  return (SYNCED_FORECAST_MODELS as readonly unknown[]).includes(v);
}

/** Whether `deviceId` is what the validator accepts: a lower-case UUID. */
export function isDeviceId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** A `schemaVersion` this client reads (the same major version). */
export function isReadableSchemaVersion(v: unknown): v is string {
  return typeof v === "string" && READABLE_SCHEMA_VERSION_RE.test(v);
}

export function isSyncableActivityId(v: unknown): v is string {
  return typeof v === "string" && ACTIVITY_ID_RE.test(v);
}

/**
 * The activities this app offers (`src/lib/activities.ts`, the same ids the
 * Worker's allowlist keys: `activity-guidance.json`, pinned equal by
 * `couch-docs.test.ts`). A document for any other id is another client's, and
 * is neither applied nor counted.
 */
const KNOWN_ACTIVITY_IDS: ReadonlySet<string> = new Set(
  ACTIVITIES.map((a) => a.id),
);

export function isKnownActivityId(v: unknown): v is string {
  return typeof v === "string" && KNOWN_ACTIVITY_IDS.has(v);
}

/**
 * The most activities a device profile holds (`MAX_ACTIVITIES` in
 * `weather_core::community`, and `platform-devices.ts`). Activities that
 * arrive from other devices are taken only up to this many; what the person
 * already holds here is never dropped to make room.
 */
export const MAX_SYNCED_ACTIVITIES = 30;

/** True for a deleted document: RxDB's `_deleted` or CouchDB's. */
function isDeleted(doc: { _deleted?: boolean }): boolean {
  return doc._deleted === true;
}

/**
 * The gate for a document this client WRITES (`upsert` in `couch-rxdb.ts`).
 * Throws for anything the pinned validator would refuse or this client does not
 * own: an unknown type, a setting this client does not own (above all
 * `homePlace`, which is locational and encrypted by the data model), a key
 * outside the allow-list, a value outside the validator's enum for the key
 * (`SYNCED_FORECAST_MODELS`), a `schemaVersion` that is not ours, a `deviceId`
 * that is not a UUID, or a time that is not exactly `…SSS Z`.
 *
 * It judges what is about to be written, not what the server holds: the push
 * modifier (`toPushDoc`) lets the assumed master state through by shape only,
 * because a value another client wrote is the server's to have written.
 */
export function assertPlaintextDoc(doc: UserDocType): void {
  if (!isOwnedDocId(doc.id)) {
    throw new Error("couch-sync: refused a document this client does not own");
  }
  if (doc.schemaVersion !== COUCH_DOC_SCHEMA_VERSION) {
    throw new Error("couch-sync: refused a schemaVersion");
  }
  if (!isDeviceId(doc.deviceId)) {
    throw new Error("couch-sync: refused a deviceId that is not a UUID");
  }
  if (
    !RFC3339_MS_RE.test(doc.createdAt) ||
    !RFC3339_MS_RE.test(doc.updatedAt)
  ) {
    throw new Error("couch-sync: refused a time that is not in the wire form");
  }
  if (doc.type === "activity") {
    if (
      doc.id !== activityDocId(doc.activityId ?? "") ||
      !isSyncableActivityId(doc.activityId) ||
      doc.preferenceKey !== undefined ||
      doc.preferenceValue !== undefined
    ) {
      throw new Error("couch-sync: refused a malformed activity document");
    }
    return;
  }
  if (doc.type === "preference") {
    const key = doc.preferenceKey;
    if (
      !key ||
      !(SYNCED_PREFERENCE_KEYS as readonly string[]).includes(key) ||
      doc.id !== preferenceDocId(key) ||
      doc.activityId !== undefined
    ) {
      throw new Error(
        "couch-sync: refused a preference this client does not own",
      );
    }
    const ok =
      key === "theme"
        ? isThemeValue(doc.preferenceValue)
        : isForecastModelValue(doc.preferenceValue);
    if (!ok) throw new Error("couch-sync: refused a preference value");
    return;
  }
  throw new Error("couch-sync: refused a document type");
}

/** A document whose every field passes the gate (used by tests and guards). */
export function isWellFormedDoc(doc: UserDocType): boolean {
  try {
    assertPlaintextDoc(doc);
    return true;
  } catch {
    return false;
  }
}

/**
 * A time in the one form the validator accepts, or null: kept as it is when it
 * already has it, else the instant it names written that way.
 */
function wireTime(value: unknown): string | null {
  if (typeof value === "string" && RFC3339_MS_RE.test(value)) return value;
  const ms = instantMs(value);
  return ms === null ? null : toRfc3339(ms);
}

// ---------------------------------------------------------------------------
// Wire form
// ---------------------------------------------------------------------------

/** The type a document id names (the part before the colon), or undefined. */
function typeOfId(id: string): UserDocType["type"] | undefined {
  if (id.startsWith("activity:")) return "activity";
  if (id.startsWith("preference:")) return "preference";
  return undefined;
}

/**
 * The fields of a live document that go to CouchDB, and nothing else: an
 * allow-list, so a field added to the RxDB document later can never leak (the
 * validator refuses any field outside the type's schema). RxDB's own `id`
 * field is swapped for `_id` by the replication plugin. Times go out in the one
 * form the validator accepts.
 */
export function pickWireFields(doc: UserDocType): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: doc.id,
    type: doc.type,
    schemaVersion: doc.schemaVersion,
    deviceId: doc.deviceId,
    createdAt: wireTime(doc.createdAt) ?? doc.createdAt,
    updatedAt: wireTime(doc.updatedAt) ?? doc.updatedAt,
  };
  if (doc.type === "preference") {
    wire.preferenceKey = doc.preferenceKey;
    wire.preferenceValue = doc.preferenceValue;
  } else {
    wire.activityId = doc.activityId;
  }
  // RxDB's own convention (the replication plugin compares the master it
  // reads, which always carries the flag, with the one it assumed).
  wire._deleted = false;
  return wire;
}

/**
 * A deleted document as the validator accepts it: `_deleted: true` WITH the
 * common fields (`type`, `schemaVersion`, `deviceId`, `createdAt`, `updatedAt`,
 * so the conflict rule can order the delete against an edit) and nothing else:
 * no `activityId`, no `preferenceKey`, no `preferenceValue`, no envelope. A
 * bare `{_id, _rev, _deleted}` stub is refused ("unknown document type").
 * Null when the document lacks what a tombstone must carry, which cannot be
 * repaired here: it is then not pushed.
 */
export function tombstoneWire(
  doc: Partial<UserDocType> & { id: string },
): Record<string, unknown> | null {
  const type = typeOfId(doc.id);
  const createdAt = wireTime(doc.createdAt);
  const updatedAt = wireTime(doc.updatedAt);
  if (
    !type ||
    !isDeviceId(doc.deviceId) ||
    !createdAt ||
    !updatedAt ||
    typeof doc.schemaVersion !== "string"
  ) {
    return null;
  }
  return {
    id: doc.id,
    type,
    schemaVersion: doc.schemaVersion,
    deviceId: doc.deviceId,
    createdAt,
    updatedAt,
    _deleted: true,
  };
}

/**
 * The push modifier. It is applied by the plugin to the NEW document state and
 * to the ASSUMED MASTER state of every row, so it judges shape only: a live
 * document is reduced to the wire allow-list, a tombstone to the common fields.
 * A value another client wrote (the assumed master may hold a forecast model
 * this app cannot show) is the server's to have written and must not block our
 * own edit of that setting; what THIS client writes is gated where it is
 * written (`assertPlaintextDoc` in `couch-rxdb.ts` `upsert`, and the planners
 * only ever build documents the validator accepts).
 *
 * `null` skips the row (RxDB's convention for a document that is not sent): an
 * id this client does not own, or a tombstone that lacks what it must carry.
 * Throwing instead would fail the cycle on every try and wedge the push.
 */
export function toPushDoc(
  doc: UserDocType & { _deleted?: boolean },
): Record<string, unknown> | null {
  if (!isOwnedDocId(doc.id)) return null;
  if (isDeleted(doc)) return tombstoneWire(doc);
  return pickWireFields(doc);
}

/**
 * The pull modifier: a document from the server reduced to the fields this
 * client knows (another client's extra fields never reach the device), a
 * tombstone to its common fields. The id gate is the fetch layer's, which has
 * already dropped every id this client does not own.
 */
export function toPullDoc<T extends { id: string; _deleted?: boolean }>(
  doc: T,
): T {
  if (isDeleted(doc)) {
    // A tombstone the validator accepted carries the common fields; one that
    // somehow does not is kept as the stub it is (it still deletes).
    return (tombstoneWire(doc as unknown as UserDocType) ?? {
      id: doc.id,
      _deleted: true,
    }) as unknown as T;
  }
  const d = doc as unknown as UserDocType;
  return pickWireFields(d) as unknown as T;
}

// ---------------------------------------------------------------------------
// Documents -> state
// ---------------------------------------------------------------------------

/**
 * What the live documents say about the app's state, as a patch against
 * `current`: only the fields that differ, so applying it is a no-op when the
 * device already agrees (no write, no echo back to the server).
 *
 *   theme, forecast model  from their document, when it exists and holds a
 *                          value the data model allows; a forecast model
 *                          the validator does not list (`meteofrance_seamless`)
 *                          is the person's own pick on this device and no
 *                          document replaces it
 *   activities             the local list in the person's own order, minus
 *                          the ids another device removed (`deletedIds`: the
 *                          ids whose TOMBSTONE the local database holds; an
 *                          id with no document at all has simply not been
 *                          seen yet and stays), plus the ids the device does
 *                          not hold yet (oldest first, then by id, up to the
 *                          device profile's limit); an id this client does
 *                          not know is never dropped
 */
export function patchFromDocs(
  docs: readonly UserDocType[],
  current: SyncableState,
  deletedIds: ReadonlySet<string> = new Set(),
): SyncedPatch {
  // Ours by id, and written against a model version this client reads.
  const live = docs.filter(
    (d) => isOwnedDocId(d.id) && isReadableSchemaVersion(d.schemaVersion),
  );
  const patch: SyncedPatch = {};

  const theme = live.find((d) => d.id === preferenceDocId("theme"));
  if (theme && isThemeValue(theme.preferenceValue)) {
    if (theme.preferenceValue !== current.theme) {
      patch.theme = theme.preferenceValue;
    }
  }
  const model = live.find((d) => d.id === preferenceDocId("forecastModel"));
  if (
    model &&
    isForecastModelValue(model.preferenceValue) &&
    // The person's own pick that the validator does not list stays: there is
    // no document for it to be compared with, and it must not be undone by a
    // document that is about something else.
    isForecastModelValue(current.selectedForecastModel)
  ) {
    if (model.preferenceValue !== current.selectedForecastModel) {
      patch.selectedForecastModel = model.preferenceValue;
    }
  }

  // Only activities this app offers: another client (the mobile app) may sync
  // an id the web app has never heard of, and it must not reach the device
  // profile or the AI summary's first three.
  const fromDocs = live
    .filter((d) => d.type === "activity" && isKnownActivityId(d.activityId))
    // Oldest first, as instants (an unreadable time sorts last), then by id.
    .sort(
      (a, b) =>
        compareInstants(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1),
    )
    .map((d) => d.activityId as string);
  const wanted = new Set(fromDocs);
  const held = new Set(current.selectedActivities);
  // The person's own order is theirs: it decides which three activities the
  // AI advice is about. Keep what the device holds where it is, then append the
  // ids it does not hold yet, oldest first, only while there is room under the
  // device profile's limit. Nothing the person already holds is removed to make
  // room, and nothing is removed because a document is MISSING: an id goes only
  // when its tombstone is here (`deletedIds`: another device deleted it and the
  // deletion was pulled), and an id this client does not know never goes.
  const kept = current.selectedActivities.filter(
    (id) =>
      !isKnownActivityId(id) ||
      wanted.has(id) ||
      !deletedIds.has(activityDocId(id)),
  );
  const room = Math.max(0, MAX_SYNCED_ACTIVITIES - kept.length);
  const next = [
    ...kept,
    ...fromDocs.filter((id) => !held.has(id)).slice(0, room),
  ];
  // Same members is not a change worth applying, whatever the order.
  if (!sameMembers(next, current.selectedActivities)) {
    patch.selectedActivities = next;
  }
  return patch;
}

/** -1, 0 or 1 by instant; a time that cannot be read is after every one that can. */
function compareInstants(a: unknown, b: unknown): number {
  const x = instantMs(a) ?? Number.POSITIVE_INFINITY;
  const y = instantMs(b) ?? Number.POSITIVE_INFINITY;
  return x === y ? 0 : x < y ? -1 : 1;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length &&
    [...a].sort().join("\n") === [...b].sort().join("\n")
  );
}

// ---------------------------------------------------------------------------
// State -> documents
// ---------------------------------------------------------------------------

function prefDoc(
  key: SyncedPreferenceKey,
  value: string,
  existing: UserDocType | undefined,
  ctx: DocContext,
): UserDocType {
  const now = toRfc3339(ctx.nowMs);
  return {
    id: preferenceDocId(key),
    type: "preference",
    schemaVersion: COUCH_DOC_SCHEMA_VERSION,
    deviceId: ctx.deviceId,
    // The first write's time is kept, in the one form the validator accepts.
    createdAt: wireTime(existing?.createdAt) ?? now,
    updatedAt: now,
    preferenceKey: key,
    preferenceValue: value,
  };
}

function activityDoc(
  activityId: string,
  existing: UserDocType | undefined,
  ctx: DocContext,
): UserDocType {
  const now = toRfc3339(ctx.nowMs);
  return {
    id: activityDocId(activityId),
    type: "activity",
    schemaVersion: COUCH_DOC_SCHEMA_VERSION,
    deviceId: ctx.deviceId,
    createdAt: wireTime(existing?.createdAt) ?? now,
    updatedAt: now,
    activityId,
  };
}

/**
 * Writes for a change the person made after sync started: what differs
 * between the state last written to documents (`prev`) and now (`next`).
 * `live` are the current live documents by id.
 */
export function planChangeOps(
  prev: SyncableState,
  next: SyncableState,
  live: ReadonlyMap<string, UserDocType>,
  ctx: DocContext,
): LocalDocOp[] {
  const ops: LocalDocOp[] = [];

  if (prev.theme !== next.theme && isThemeValue(next.theme)) {
    ops.push({
      kind: "upsert",
      doc: prefDoc(
        "theme",
        next.theme,
        live.get(preferenceDocId("theme")),
        ctx,
      ),
    });
  }
  if (
    prev.selectedForecastModel !== next.selectedForecastModel &&
    isForecastModelValue(next.selectedForecastModel)
  ) {
    ops.push({
      kind: "upsert",
      doc: prefDoc(
        "forecastModel",
        next.selectedForecastModel,
        live.get(preferenceDocId("forecastModel")),
        ctx,
      ),
    });
  }

  const before = new Set(prev.selectedActivities);
  const after = new Set(next.selectedActivities);
  for (const id of after) {
    if (before.has(id) || !isSyncableActivityId(id)) continue;
    ops.push({
      kind: "upsert",
      doc: activityDoc(id, live.get(activityDocId(id)), ctx),
    });
  }
  for (const id of before) {
    if (after.has(id) || !isSyncableActivityId(id)) continue;
    if (live.has(activityDocId(id))) {
      ops.push({ kind: "tombstone", id: activityDocId(id) });
    }
  }
  return ops;
}

/**
 * Writes for state that predates sync: a non-default local value gets a
 * document only when NO document of any kind (live or deleted) exists for it.
 * A fresh device with default settings therefore writes nothing and can never
 * overwrite the settings the person made elsewhere with its own defaults.
 * `known` is the set of ids that already have a document.
 */
export function planSeedOps(
  state: SyncableState,
  known: ReadonlySet<string>,
  ctx: DocContext,
): LocalDocOp[] {
  const ops: LocalDocOp[] = [];
  if (
    isThemeValue(state.theme) &&
    state.theme !== DEFAULT_THEME &&
    !known.has(preferenceDocId("theme"))
  ) {
    ops.push({
      kind: "upsert",
      doc: prefDoc("theme", state.theme, undefined, ctx),
    });
  }
  if (
    isForecastModelValue(state.selectedForecastModel) &&
    state.selectedForecastModel !== DEFAULT_FORECAST_MODEL &&
    !known.has(preferenceDocId("forecastModel"))
  ) {
    ops.push({
      kind: "upsert",
      doc: prefDoc(
        "forecastModel",
        state.selectedForecastModel,
        undefined,
        ctx,
      ),
    });
  }
  for (const id of state.selectedActivities) {
    if (!isSyncableActivityId(id) || known.has(activityDocId(id))) continue;
    ops.push({ kind: "upsert", doc: activityDoc(id, undefined, ctx) });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

type ConflictDoc = Partial<UserDocType> & { id: string; _deleted?: boolean };

/**
 * The winner of two documents for one id: `master` is what CouchDB holds,
 * `fork` is this device's version. The later `updatedAt` wins, compared as
 * instants (`instantMs`: any RFC 3339 form, not text); on a tie the master
 * stays, and so it does when either time cannot be read (the server's
 * revision is the one every device already agrees on).
 *
 * A tombstone is a revision like any other: the validator makes it carry
 * `updatedAt` (the common fields), so a delete and an edit are ordered by their
 * times and nothing wins merely for being a delete. A device that picked an
 * activity again AFTER another device removed it therefore wins (its revision is
 * the later one), and a removal made after the other device's edit wins too.
 */
export function resolveUserDocConflict<T extends ConflictDoc>(
  master: T,
  fork: T,
): T {
  const m = instantMs(master.updatedAt);
  const f = instantMs(fork.updatedAt);
  if (m === null || f === null) return master;
  return f > m ? fork : master;
}
