// The two stores, over a deliberately narrow collection interface. Every
// query is built here from validated fields; the handlers never pass a
// filter, an update or a projection through from the caller. The documents
// keep the shapes the Python backend wrote, so nothing is migrated:
//
//   device.device_profiles   {deviceId, preferences{...}, createdAt, updatedAt}
//   weather.weather_reports  {locationSlug, locationName, lat, lon, reportType,
//                             severity, description, weatherSnapshot{...},
//                             reportedBy, reportedAt, expiresAt, upvotes,
//                             upvotedBy[], verified}   (_id is an ObjectId)
//
// Indexes are not created from code (owner step: TTL on expiresAt, unique
// deviceId, {locationSlug, reportedAt}).

import { ObjectId, type Collection, type Document } from "mongodb";
import {
  HISTORY_MAX_KEYS,
  HISTORY_MAX_SPAN_DAYS,
  LIST_LIMIT,
  readPreferences,
  validSlug,
  type ArchiveDay,
  type NewReport,
  type Preferences,
  type WeatherSnapshot,
} from "./validate";

export type Doc = Record<string, unknown>;

/** The few collection operations the stores use. */
export interface Coll {
  findOne(filter: Doc, projection?: Doc): Promise<Doc | null>;
  insertOne(doc: Doc): Promise<{ insertedId: unknown }>;
  findOneAndUpdate(
    filter: Doc,
    update: Doc,
    options: { upsert?: boolean },
  ): Promise<Doc | null>;
  updateOne(filter: Doc, update: Doc): Promise<{ modifiedCount: number }>;
  findMany(
    filter: Doc,
    options: { projection: Doc; sort: Doc; limit: number },
  ): Promise<Doc[]>;
  /**
   * Insert each document unless one with the same filter exists (insert-only:
   * `$setOnInsert` with upsert, unordered). Returns how many were inserted;
   * a duplicate-key race with another writer is not an error.
   */
  insertIfAbsent(
    items: { filter: Doc; doc: Doc }[],
  ): Promise<{ inserted: number }>;
}

/** A server-side time limit on every operation, so a stuck query frees the connection. */
const MAX_TIME_MS = 5_000;

/** The real driver collection as a `Coll`. A string `_id` becomes an ObjectId. */
export function fromMongo(col: Collection<Document>): Coll {
  const fix = (filter: Doc): Document => {
    const out: Document = { ...filter };
    if (typeof out._id === "string") out._id = new ObjectId(out._id);
    return out;
  };
  return {
    findOne: (filter, projection) =>
      col.findOne(fix(filter), { projection, maxTimeMS: MAX_TIME_MS }),
    insertOne: (doc) => col.insertOne({ ...doc }),
    findOneAndUpdate: (filter, update, options) =>
      col.findOneAndUpdate(fix(filter), update, {
        upsert: options.upsert ?? false,
        returnDocument: "after",
        maxTimeMS: MAX_TIME_MS,
      }),
    updateOne: async (filter, update) => {
      const r = await col.updateOne(fix(filter), update, {
        maxTimeMS: MAX_TIME_MS,
      });
      return { modifiedCount: r.modifiedCount };
    },
    insertIfAbsent: async (items) => {
      if (items.length === 0) return { inserted: 0 };
      try {
        const r = await col.bulkWrite(
          items.map(({ filter, doc }) => ({
            updateOne: { filter, update: { $setOnInsert: doc }, upsert: true },
          })),
          { ordered: false },
        );
        return { inserted: r.upsertedCount };
      } catch (e) {
        // A concurrent writer won the unique (locationSlug, date) race for
        // some days: theirs stays, ours is dropped. Anything else is real.
        const errors = (e as { writeErrors?: { code?: number }[] }).writeErrors;
        const result = (e as { result?: { upsertedCount?: number } }).result;
        if (
          Array.isArray(errors) &&
          errors.length > 0 &&
          errors.every((x) => x.code === 11000)
        ) {
          return { inserted: result?.upsertedCount ?? 0 };
        }
        throw e;
      }
    },
    findMany: (filter, options) =>
      col
        .find(fix(filter), {
          projection: options.projection,
          maxTimeMS: MAX_TIME_MS,
        })
        .sort(options.sort as Document)
        .limit(options.limit)
        .toArray(),
  };
}

// --- device profiles -------------------------------------------------------

export interface DeviceProfile {
  deviceId: string;
  preferences: Preferences;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceStore {
  find(deviceId: string): Promise<DeviceProfile | null>;
  /** The existing profile when there is one (idempotent), else a new one. */
  create(
    deviceId: string,
    preferences: Preferences,
    now: Date,
  ): Promise<DeviceProfile>;
  /** `$set` of validated dotted paths; `null` when there is no such device. */
  patch(
    deviceId: string,
    set: Record<string, unknown>,
    now: Date,
  ): Promise<DeviceProfile | null>;
}

function iso(v: unknown): string {
  return v instanceof Date && !Number.isNaN(v.getTime())
    ? v.toISOString()
    : new Date(0).toISOString();
}

function profileOf(doc: Doc): DeviceProfile {
  return {
    deviceId: String(doc.deviceId),
    preferences: readPreferences(doc.preferences),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

/** A duplicate key error: two creates of one id raced past a unique index. */
export function isDuplicateKey(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === 11000
  );
}

export function deviceStore(col: Coll): DeviceStore {
  return {
    async find(deviceId) {
      const doc = await col.findOne({ deviceId });
      return doc ? profileOf(doc) : null;
    },
    async create(deviceId, preferences, now) {
      const insert = {
        $setOnInsert: { preferences, createdAt: now, updatedAt: now },
      };
      try {
        // One atomic upsert: a new id inserts, an existing id is returned
        // untouched. `deviceId` comes from the filter's equality.
        const doc = await col.findOneAndUpdate({ deviceId }, insert, {
          upsert: true,
        });
        if (doc) return profileOf(doc);
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;
      }
      // Lost a race to a concurrent create of the same id (unique index).
      const doc = await col.findOne({ deviceId });
      if (!doc) throw new Error("device profile vanished");
      return profileOf(doc);
    },
    async patch(deviceId, set, now) {
      const doc = await col.findOneAndUpdate(
        { deviceId },
        { $set: { ...set, updatedAt: now } },
        {},
      );
      return doc ? profileOf(doc) : null;
    },
  };
}

// --- reports ---------------------------------------------------------------

export interface ReportView {
  id: string;
  reportType: string;
  severity: string;
  description: string;
  reportedAt: string;
  upvotes: number;
  verified: boolean;
  locationName: string;
}

export interface ReportStore {
  /** Inserts and returns the new report's id (24 hex). */
  insert(report: NewReport, now: Date, expiresAt: Date): Promise<string>;
  /** Unexpired reports for these keys since `cutoff`, newest first. */
  recent(
    keys: string[],
    cutoff: Date,
    now: Date,
    limit: number,
  ): Promise<ReportView[]>;
  /** One vote per voter, atomic. `false`: already voted, or no such report. */
  upvote(reportId: string, voter: string): Promise<boolean>;
}

const REPORT_PROJECTION: Doc = {
  _id: 1,
  reportType: 1,
  severity: 1,
  description: 1,
  reportedAt: 1,
  upvotes: 1,
  verified: 1,
  locationName: 1,
};

function viewOf(doc: Doc): ReportView {
  return {
    id: String(doc._id),
    reportType: String(doc.reportType ?? ""),
    severity: String(doc.severity ?? ""),
    description: typeof doc.description === "string" ? doc.description : "",
    reportedAt: iso(doc.reportedAt),
    upvotes: typeof doc.upvotes === "number" ? doc.upvotes : 0,
    verified: doc.verified === true,
    locationName: typeof doc.locationName === "string" ? doc.locationName : "",
  };
}

export function reportStore(col: Coll): ReportStore {
  return {
    async insert(report, now, expiresAt) {
      const snapshot: Partial<WeatherSnapshot> = report.weatherSnapshot;
      const res = await col.insertOne({
        locationSlug: report.locationSlug,
        locationName: report.locationName,
        lat: report.lat,
        lon: report.lon,
        reportType: report.reportType,
        severity: report.severity,
        description: report.description,
        weatherSnapshot: snapshot,
        reportedBy: report.reportedBy,
        reportedAt: now,
        expiresAt,
        upvotes: 0,
        upvotedBy: [],
        verified: report.verified,
      });
      return String(res.insertedId);
    },
    async recent(keys, cutoff, now, limit) {
      const docs = await col.findMany(
        {
          locationSlug: { $in: keys },
          reportedAt: { $gte: cutoff },
          expiresAt: { $gt: now },
        },
        {
          projection: REPORT_PROJECTION,
          sort: { reportedAt: -1 },
          limit: Math.min(Math.max(Math.trunc(limit), 1), LIST_LIMIT),
        },
      );
      return docs.map(viewOf);
    },
    async upvote(reportId, voter) {
      // One update: the filter keeps a voter who already voted out, so the
      // `$inc` runs only when `$addToSet` really adds.
      const res = await col.updateOne(
        { _id: reportId, upvotedBy: { $ne: voter } },
        { $addToSet: { upvotedBy: voter }, $inc: { upvotes: 1 } },
      );
      return res.modifiedCount === 1;
    },
  };
}

// --- weather history -------------------------------------------------------
//
//   weather.weather_history  {locationSlug, date, source, provider, aggregation,
//                             current{...}, daily{...}, insights{...},
//                             recordedAt, createdAt}
//   UNIQUE index {locationSlug: 1, date: -1} (db-init). Never created here.

export interface HistoryStore {
  /** Days dated `start`..`end` under any of the keys, newest first. */
  read(keys: string[], start: string, end: string): Promise<Doc[]>;
  /** Insert-only: a day that exists is left untouched. */
  insertArchiveDays(
    key: string,
    days: ArchiveDay[],
    now: Date,
  ): Promise<{ inserted: number; existing: number }>;
}

const HISTORY_PROJECTION: Doc = {
  _id: 0,
  locationSlug: 1,
  date: 1,
  source: 1,
  provider: 1,
  aggregation: 1,
  current: 1,
  daily: 1,
  insights: 1,
  recordedAt: 1,
};

/** Never more than three keys over ten years. */
const HISTORY_READ_LIMIT = HISTORY_MAX_KEYS * HISTORY_MAX_SPAN_DAYS;

export function historyStore(col: Coll): HistoryStore {
  return {
    async read(keys, start, end) {
      const docs = await col.findMany(
        { locationSlug: { $in: keys }, date: { $gte: start, $lte: end } },
        {
          projection: HISTORY_PROJECTION,
          sort: { date: -1 },
          limit: HISTORY_READ_LIMIT,
        },
      );
      return docs
        .filter((d) => typeof d.date === "string")
        .map((d) => ({
          ...d,
          // Documents written before `source` existed were recorded days.
          source: typeof d.source === "string" ? d.source : "recorded",
          recordedAt: iso(d.recordedAt),
        }));
    },
    async insertArchiveDays(key, days, now) {
      const { inserted } = await col.insertIfAbsent(
        days.map((d) => ({
          filter: { locationSlug: key, date: d.date },
          doc: {
            source: d.source,
            provider: d.source,
            aggregation: "daily-mean",
            current: d.current,
            daily: d.daily,
            ...(d.insights ? { insights: d.insights } : {}),
            recordedAt: now,
            createdAt: now,
          },
        })),
      );
      return { inserted, existing: days.length - inserted };
    },
  };
}

// --- platform aliases of a place ---------------------------------------------
//
//   places.placesGeo  {slug: "<name>-<last 6 hex of _id>", name, geoType,
//                      geo (GeoJSON Point, 2dsphere index)}       READ ONLY
//
// A writer that recorded "the weather at the nearest known place" keyed the
// day by that place's PLATFORM slug (`nairobi-518dd4`) instead of the
// catalogue slug (`nairobi-ke`), and still does. Those days belong to the
// catalogue place, so a history read also asks for them. The alias is found
// from the place RECORD: the placesGeo cities, towns and villages within
// ALIAS_RADIUS_KM of the place's own coordinates whose slug is the place's
// name and six hex digits. A name alone cannot do it, because placesGeo holds
// two Nyangas (a town in Zimbabwe, a province in Gabon) and a Nairobi city
// beside a Nairobi province: matching `nairobi-*` or `nyanga-*` would merge
// another place's weather into this one.
//
// The bridge's Atlas user needs `read` on `places.placesGeo` for this (owner
// step in workers/README.md). Without it the lookup fails closed: no aliases,
// the plain keys still answer, and the failure is cached for a few minutes.

export interface PlaceAliasStore {
  /**
   * The platform slugs of the place `slug` at (`lat`, `lon`), at most
   * ALIAS_MAX. Never throws: a lookup that fails is an empty list.
   */
  aliasesOf(slug: string, lat: number, lon: number): Promise<string[]>;
  /**
   * The community place stamped with `slug` (`sourceProvenance.mukokoSlug`).
   * Never throws. `unavailable` means the read failed or is not permitted:
   * the caller must not treat it as "no such place" (it fails closed).
   */
  bySlug(slug: string): Promise<PlaceLookup>;
}

// --- a community place by its app slug -------------------------------------
//
// The places the community created through geolocation and search are
// placesGeo documents stamped with the slug the app uses (`windsor-avenue-zw`;
// the platform's own slug is `windsor-avenue-00fc5a`). The Python resolved
// them; the Rust Workers read no database for places, so the bridge (which
// already reads placesGeo for history aliases) answers one narrow question:
// the place for ONE validated slug. The filter and the projection are built
// here, the result is checked field by field, and a document that does not
// look like a place is "none". Same Atlas `read` as the aliases above.

/** The few fields of a placesGeo document the Workers need. */
export interface CommunityPlace {
  slug: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number | null;
  province: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string | null;
  tags: string[];
}

export type PlaceLookup =
  | { kind: "found"; place: CommunityPlace }
  | { kind: "none" }
  | { kind: "unavailable" };

const PLACE_PROJECTION: Doc = {
  _id: 0,
  name: 1,
  isoCode: 1,
  geo: 1,
  "sourceProvenance.mukokoProvince": 1,
  "sourceProvenance.mukokoElevation": 1,
  "sourceProvenance.mukokoTags": 1,
  "sourceProvenance.mukokoNominatimAddress.countryCode": 1,
};
const PLACE_FOUND_TTL_MS = 600_000;
const PLACE_NONE_TTL_MS = 120_000;
/** After a failed read (for example not permitted) nothing is asked for this long. */
const PLACE_FAILURE_TTL_MS = 300_000;
const PLACE_CACHE_MAX = 500;
const MAX_PLACE_NAME = 120;
const MAX_PLACE_TAGS = 10;

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A placesGeo document as a `CommunityPlace`, or null when it is not one. */
export function placeView(slug: string, doc: Doc): CommunityPlace | null {
  const name = typeof doc.name === "string" ? doc.name.trim() : "";
  if (name === "") return null;
  const coordinates = isRecord(doc.geo) ? doc.geo.coordinates : undefined;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lon, lat] = coordinates as unknown[];
  if (
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return null;
  }
  const prov = isRecord(doc.sourceProvenance) ? doc.sourceProvenance : {};
  const elevation = prov.mukokoElevation;
  const province = prov.mukokoProvince;
  const address = isRecord(prov.mukokoNominatimAddress)
    ? prov.mukokoNominatimAddress
    : {};
  const iso = [doc.isoCode, address.countryCode].find(
    (c): c is string => typeof c === "string" && /^[A-Za-z]{2}$/.test(c),
  );
  const tags = Array.isArray(prov.mukokoTags)
    ? prov.mukokoTags
        .filter(
          (t): t is string =>
            typeof t === "string" && /^[a-z0-9-]{1,40}$/.test(t),
        )
        .slice(0, MAX_PLACE_TAGS)
    : [];
  return {
    slug,
    name: [...name].slice(0, MAX_PLACE_NAME).join(""),
    lat,
    lon,
    elevation:
      typeof elevation === "number" &&
      Number.isFinite(elevation) &&
      elevation >= -500 &&
      elevation <= 9000
        ? elevation
        : null,
    province:
      typeof province === "string"
        ? [...province.trim()].slice(0, 80).join("")
        : "",
    country: iso ? iso.toUpperCase() : null,
    tags,
  };
}

/** The writers attributed a request to the nearest known place within 25 km. */
export const ALIAS_RADIUS_KM = 25;
/** Mean Earth radius (km) for `$centerSphere`, which takes radians. */
const EARTH_RADIUS_KM = 6378.1;
const ALIAS_GEO_TYPES = ["city", "town", "village"];
/** Candidate places read near the point (only their slugs). */
const ALIAS_CANDIDATES = 100;
/** One place has one city, perhaps one town record beside it. */
export const ALIAS_MAX = 2;
const ALIAS_TTL_MS = 3_600_000;
const ALIAS_FAILURE_TTL_MS = 300_000;
const ALIAS_CACHE_MAX = 500;

/**
 * The names a catalogue slug can be a place's platform alias of: the slug
 * itself (`harare`) and, when it ends in a country suffix, the slug without it
 * (`nairobi-ke` -> `nairobi`).
 */
export function aliasBases(slug: string): string[] {
  const stripped = slug.replace(/-[a-z]{2}$/, "");
  return stripped !== slug && stripped !== "" ? [slug, stripped] : [slug];
}

/** Whether `candidate` is one of the bases, a dash and six hex digits. */
export function isAliasOf(
  candidate: unknown,
  bases: string[],
): candidate is string {
  if (typeof candidate !== "string" || !validSlug(candidate)) return false;
  const m = /^(.+)-[0-9a-f]{6}$/.exec(candidate);
  return m !== null && bases.includes(m[1]!);
}

export function placeAliasStore(
  col: Coll,
  now: () => number = Date.now,
): PlaceAliasStore {
  const cache = new Map<string, { aliases: string[]; until: number }>();
  const placeCache = new Map<string, { value: PlaceLookup; until: number }>();
  let placesBlockedUntil = 0;
  return {
    async bySlug(slug) {
      const t = now();
      if (placesBlockedUntil > t) return { kind: "unavailable" };
      const hit = placeCache.get(slug);
      if (hit && hit.until > t) return hit.value;
      let value: PlaceLookup;
      let ttl: number;
      try {
        const doc = await col.findOne(
          { "sourceProvenance.mukokoSlug": slug },
          PLACE_PROJECTION,
        );
        const place = doc ? placeView(slug, doc) : null;
        value = place ? { kind: "found", place } : { kind: "none" };
        ttl = place ? PLACE_FOUND_TTL_MS : PLACE_NONE_TTL_MS;
      } catch (e) {
        // Name only: a driver message can carry host names or filters. Fail
        // closed: say "unavailable", and do not ask again for a few minutes.
        console.warn(
          `mongo-bridge: place lookup failed: ${e instanceof Error ? e.name : "error"}`,
        );
        placesBlockedUntil = t + PLACE_FAILURE_TTL_MS;
        return { kind: "unavailable" };
      }
      if (placeCache.size >= PLACE_CACHE_MAX) placeCache.clear();
      placeCache.set(slug, { value, until: t + ttl });
      return value;
    },
    async aliasesOf(slug, lat, lon) {
      const t = now();
      const cacheKey = `${slug}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
      const hit = cache.get(cacheKey);
      if (hit && hit.until > t) return hit.aliases;
      const bases = aliasBases(slug);
      let aliases: string[] = [];
      let ttl = ALIAS_TTL_MS;
      try {
        const docs = await col.findMany(
          {
            geoType: { $in: ALIAS_GEO_TYPES },
            geo: {
              $geoWithin: {
                $centerSphere: [[lon, lat], ALIAS_RADIUS_KM / EARTH_RADIUS_KM],
              },
            },
          },
          {
            projection: { _id: 0, slug: 1 },
            sort: { slug: 1 },
            limit: ALIAS_CANDIDATES,
          },
        );
        aliases = [
          ...new Set(
            docs.map((d) => d.slug).filter((s) => isAliasOf(s, bases)),
          ),
        ].slice(0, ALIAS_MAX) as string[];
      } catch (e) {
        // Name only: a driver message can carry host names or filters.
        console.warn(
          `mongo-bridge: place alias lookup failed: ${e instanceof Error ? e.name : "error"}`,
        );
        ttl = ALIAS_FAILURE_TTL_MS;
      }
      if (cache.size >= ALIAS_CACHE_MAX) cache.clear();
      cache.set(cacheKey, { aliases, until: t + ttl });
      return aliases;
    },
  };
}
