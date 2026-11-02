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
 * THE DOCUMENT SHAPE FOLLOWS THE VALIDATOR THAT RUNS IN COUCHDB, not the
 * generated schema. The two disagree today (nyuchi-api
 * `gateway/lib/couch_validate_personal.js` against data-infra
 * `schemas/generated/couchdb/user.*.schema.json`):
 *
 *   field          deployed validator (enforced)      data-infra schema
 *   schemaVersion  whole number >= 1                  string `v3.1`
 *   ownerPersonId  required, must equal the user      not a property
 *   tombstone      only _id, _rev, _deleted           keeps the common fields
 *
 * A write the deployed validator refuses never lands, so the constants
 * below (`COUCH_DOC_SCHEMA_VERSION`) and `tombstoneWire` follow the
 * validator. When the two contracts are reconciled, this file and its
 * fixtures are the only place that changes.
 *
 * CONFLICTS. The rule of docs/architecture/couchdb-documents.md (nyuchi-api):
 * the revision with the later `updatedAt` wins; on an equal `updatedAt` the
 * revision CouchDB chose (the master) stays. A tombstone carries no
 * `updatedAt` (the validator forbids it), so a delete that arrives from the
 * server cannot be ordered against a local edit and wins: a delete is never
 * undone by an edit that cannot be shown to be newer.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The `schemaVersion` the deployed validator accepts (a whole number >= 1). */
export const COUCH_DOC_SCHEMA_VERSION = 1;

export const THEME_VALUES = ["light", "dark", "system"] as const;
export type ThemeValue = (typeof THEME_VALUES)[number];

/**
 * `forecastModel` values the data model allows (data-infra
 * `user.preference.schema.json`). The app's own list is wider or narrower in
 * places (`meteofrance_seamless` is not here), and a value outside this list
 * is simply not synced, never rewritten.
 */
export const FORECAST_MODEL_VALUES = [
  "best_match",
  "ecmwf_ifs",
  "ecmwf_aifs025_single",
  "gfs_seamless",
  "icon_global",
  "ukmo_global_deterministic_10km",
  "cma_grapes_global",
  "gem_global",
  "meteofrance_arpege_world",
  "jma_gsm",
] as const;
export type ForecastModelValue = (typeof FORECAST_MODEL_VALUES)[number];

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
/** `user_<personId>`: a CouchDB database name made of lower-case characters. */
const PERSONAL_DB_RE = /^user_([a-z0-9][a-z0-9_-]{0,127})$/;

const RFC3339_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A document as RxDB stores it: the CouchDB `_id` is the `id` field. */
export interface UserDocType {
  id: string;
  type: "preference" | "activity";
  schemaVersion: number;
  ownerPersonId: string;
  /** The install that wrote it (a random UUID, data-infra `deviceId`). */
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
  personId: string;
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

/** The CouchDB wire form of a time: always three fractional digits, UTC. */
export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

export function isThemeValue(v: unknown): v is ThemeValue {
  return (THEME_VALUES as readonly unknown[]).includes(v);
}

export function isForecastModelValue(v: unknown): v is ForecastModelValue {
  return (FORECAST_MODEL_VALUES as readonly unknown[]).includes(v);
}

export function isSyncableActivityId(v: unknown): v is string {
  return typeof v === "string" && ACTIVITY_ID_RE.test(v);
}

/** The person id inside a `user_<personId>` database name, else null. */
export function personIdFromDatabase(database: unknown): string | null {
  if (typeof database !== "string") return null;
  const match = PERSONAL_DB_RE.exec(database);
  return match ? match[1] : null;
}

/** True for a deleted document: RxDB's `_deleted` or CouchDB's. */
function isDeleted(doc: { _deleted?: boolean }): boolean {
  return doc._deleted === true;
}

/**
 * The last gate before a document leaves the device. Throws for anything that
 * is not an owned plaintext document: an unknown type, a setting this client
 * does not own (above all `homePlace`, which is locational and encrypted by
 * the data model), a key outside the allow-list, or a value the data model
 * does not allow.
 */
export function assertPlaintextDoc(doc: UserDocType): void {
  if (!isOwnedDocId(doc.id)) {
    throw new Error("couch-sync: refused a document this client does not own");
  }
  if (doc.type === "activity") {
    if (
      doc.id !== activityDocId(doc.activityId ?? "") ||
      !isSyncableActivityId(doc.activityId)
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
      doc.id !== preferenceDocId(key)
    ) {
      throw new Error("couch-sync: refused a preference this client does not own");
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

/** A document whose every field passes the data model (used by tests and guards). */
export function isWellFormedDoc(doc: UserDocType): boolean {
  try {
    assertPlaintextDoc(doc);
  } catch {
    return false;
  }
  return (
    Number.isInteger(doc.schemaVersion) &&
    doc.schemaVersion >= 1 &&
    typeof doc.ownerPersonId === "string" &&
    doc.ownerPersonId.length > 0 &&
    UUID_RE.test(doc.deviceId) &&
    RFC3339_MS_RE.test(doc.createdAt) &&
    RFC3339_MS_RE.test(doc.updatedAt)
  );
}

// ---------------------------------------------------------------------------
// Wire form
// ---------------------------------------------------------------------------

/**
 * The fields of a live document that go to CouchDB, and nothing else: an
 * allow-list, so a field added to the RxDB document later can never leak.
 * RxDB's own `id` field is swapped for `_id` by the replication plugin.
 */
export function pickWireFields(doc: UserDocType): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: doc.id,
    type: doc.type,
    schemaVersion: doc.schemaVersion,
    ownerPersonId: doc.ownerPersonId,
    deviceId: doc.deviceId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
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
 * A deleted document as the deployed validator accepts it: the id and the
 * `_deleted` flag only. Any other field is refused by CouchDB.
 */
export function tombstoneWire(id: string): { id: string; _deleted: true } {
  return { id, _deleted: true };
}

/** The push modifier: a tombstone shrinks to its stub, a live document is gated. */
export function toPushDoc(
  doc: UserDocType & { _deleted?: boolean },
): Record<string, unknown> {
  if (isDeleted(doc)) return tombstoneWire(doc.id);
  assertPlaintextDoc(doc);
  return pickWireFields(doc);
}

/**
 * The pull modifier: a document from the server reduced to the fields this
 * client knows (another client's extra fields never reach the device), a
 * tombstone to its stub. The id gate is the fetch layer's, which has already
 * dropped every id this client does not own.
 */
export function toPullDoc<T extends { id: string; _deleted?: boolean }>(
  doc: T,
): T {
  if (isDeleted(doc)) return tombstoneWire(doc.id) as unknown as T;
  const d = doc as unknown as UserDocType;
  return pickWireFields(d) as unknown as T;
}

// ---------------------------------------------------------------------------
// Documents -> state
// ---------------------------------------------------------------------------

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * What the live documents say about the app's state, as a patch against
 * `current`: only the fields that differ, so applying it is a no-op when the
 * device already agrees (no write, no echo back to the server).
 *
 *   theme, forecast model  from their document, when it exists and holds a
 *                          value the data model allows
 *   activities             the documents' ids (oldest first, then by id),
 *                          plus the local ids this client could not have
 *                          synced (an id outside the id pattern), which are
 *                          never dropped by a sync
 */
export function patchFromDocs(
  docs: readonly UserDocType[],
  current: SyncableState,
): SyncedPatch {
  const live = docs.filter((d) => isOwnedDocId(d.id));
  const patch: SyncedPatch = {};

  const theme = live.find((d) => d.id === preferenceDocId("theme"));
  if (theme && isThemeValue(theme.preferenceValue)) {
    if (theme.preferenceValue !== current.theme) {
      patch.theme = theme.preferenceValue;
    }
  }
  const model = live.find((d) => d.id === preferenceDocId("forecastModel"));
  if (model && isForecastModelValue(model.preferenceValue)) {
    if (model.preferenceValue !== current.selectedForecastModel) {
      patch.selectedForecastModel = model.preferenceValue;
    }
  }

  const fromDocs = live
    .filter((d) => d.type === "activity" && isSyncableActivityId(d.activityId))
    .sort(
      (a, b) =>
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        (a.id < b.id ? -1 : 1),
    )
    .map((d) => d.activityId as string);
  const unsyncable = current.selectedActivities.filter(
    (id) => !isSyncableActivityId(id),
  );
  const next = [...fromDocs, ...unsyncable];
  if (!sameList(next, current.selectedActivities)) {
    // Same members in another order is not a change worth applying.
    const sameMembers =
      next.length === current.selectedActivities.length &&
      [...next].sort().join("\n") ===
        [...current.selectedActivities].sort().join("\n");
    if (!sameMembers) patch.selectedActivities = next;
  }
  return patch;
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
    ownerPersonId: ctx.personId,
    deviceId: ctx.deviceId,
    createdAt: existing?.createdAt ?? now,
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
    ownerPersonId: ctx.personId,
    deviceId: ctx.deviceId,
    createdAt: existing?.createdAt ?? now,
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
      doc: prefDoc("theme", next.theme, live.get(preferenceDocId("theme")), ctx),
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
      doc: prefDoc("forecastModel", state.selectedForecastModel, undefined, ctx),
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
 * `fork` is this device's version. Later `updatedAt` wins; on a tie the
 * master stays. A tombstone from the master has no `updatedAt` and wins; a
 * local tombstone (which keeps its `updatedAt` on the device) is ordered
 * normally.
 */
export function resolveUserDocConflict<T extends ConflictDoc>(
  master: T,
  fork: T,
): T {
  if (isDeleted(master) && master.updatedAt === undefined) return master;
  const m = master.updatedAt;
  const f = fork.updatedAt;
  if (typeof f === "string" && typeof m === "string" && f > m) return fork;
  if (typeof f === "string" && typeof m !== "string") return fork;
  return master;
}
