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
  LIST_LIMIT,
  readPreferences,
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
