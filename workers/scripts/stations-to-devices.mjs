// One-off migration, part 1 of 2 (B3 of the station-console plan, #561; the
// plan is #293 Part 5.7). Turns a `mongoexport --jsonArray` of weather.stations
// into batch files for the Nyuchi API's import route,
//   POST /v1/stations/import   (nyuchi/nyuchi-api#544)
// which writes each station to device.devices and its key hash and salt, unchanged,
// to device.ingest_credentials, so every key already configured in the field keeps
// working after STATIONS_BACKEND is flipped to "nyuchi".
//
// This only transforms a file: it connects to no database and makes no request.
// It prints counts and masked ids, never a hash, a salt or a name. The batch files
// DO hold the key hashes (that is what the route stores), so they are written
// readable by you alone (0600, in a 0700 directory). Delete them, and the export,
// when the import is done. The runbook is workers/README.md, "Station import".
//
//   node workers/scripts/stations-to-devices.mjs stations.json \
//     [--out stations-import] [--batch-size 50]
//
// It replaces stations-to-d1.mjs on the Nyuchi path (that script and the D1
// migration stay: STATIONS_BACKEND=d1 is still the default).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The route accepts at most this many stations in one request. */
export const MAX_BATCH = 100;
export const DEFAULT_BATCH = 50;
/** The only scheme the legacy Python and Rust routes ever wrote. */
export const ALGO = "pbkdf2-sha256-60000";

const STATION_ID = /^mws-[a-f0-9]{8}$/;
// Python's `.hex()`: 32 bytes, lowercase. The route refuses anything else, because
// the API compares lowercase hex and any other form could never verify.
const HASH = /^[0-9a-f]{64}$/;
const SALT = /^[\x21-\x7e]{1,128}$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const MAX_SKEW_MS = 5 * 60 * 1000;

/** `mws-0a1b2c3d` -> `mws-0a****3d`. Anything that is not a station id is not echoed. */
export function maskId(id) {
  return typeof id === "string" && STATION_ID.test(id)
    ? `${id.slice(0, 6)}****${id.slice(-2)}`
    : "(not a station id)";
}

// --- MongoDB Extended JSON (what mongoexport writes) --------------------------

/** A finite number from a plain number or an Extended JSON number wrapper, else null. */
function number(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object") {
    for (const key of [
      "$numberDouble",
      "$numberInt",
      "$numberLong",
      "$numberDecimal",
    ]) {
      if (key in v) {
        const n = Number(v[key]);
        return Number.isFinite(n) ? n : null;
      }
    }
  }
  return null;
}

/** An RFC 3339 UTC string from `{"$date": ...}` (string or `$numberLong`) or a string, else null. */
function isoDate(v) {
  let raw = v && typeof v === "object" && "$date" in v ? v.$date : v;
  if (raw && typeof raw === "object" && "$numberLong" in raw)
    raw = Number(raw.$numberLong);
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function text(v, { min, max }) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= min && t.length <= max && !CONTROL.test(t) ? t : null;
}

// --- one station ---------------------------------------------------------------

/**
 * One exported weather.stations document to one import item, or the reason it
 * cannot be imported. `notes` name optional things that were set aside so the
 * station could still be imported (a bad elevation must not cost a station its
 * key). Nothing here returns or logs a value of the document except the item.
 */
export function transformStation(doc, { now = Date.now() } = {}) {
  const notes = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return { skip: "not_an_object", notes };

  const stationId = doc.stationId;
  if (typeof stationId !== "string" || !STATION_ID.test(stationId))
    return { skip: "no_station_id", notes };
  // The StationKit seed document (nyuchi-africa-hq-harare) and anything else
  // without a key hash is not a station a console can upload to.
  if (!doc.ingestKeyHash || !doc.ingestKeySalt)
    return { skip: "no_key", stationId, notes };
  if (typeof doc.ingestKeyHash !== "string" || !HASH.test(doc.ingestKeyHash))
    return { skip: "bad_hash", stationId, notes };
  if (typeof doc.ingestKeySalt !== "string" || !SALT.test(doc.ingestKeySalt))
    return { skip: "bad_salt", stationId, notes };

  // GeoJSON order is [longitude, latitude]; the Python route also wrote lat and lon.
  const coords = doc.location?.coordinates;
  const lon = number(Array.isArray(coords) ? coords[0] : doc.lon);
  const lat = number(Array.isArray(coords) ? coords[1] : doc.lat);
  if (
    lat === null ||
    lon === null ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  )
    return { skip: "bad_position", stationId, notes };

  let name = text(doc.name ?? doc.stationName, { min: 2, max: 80 });
  if (name === null) {
    name = stationId; // the old D1 script did the same
    notes.push("name_defaulted");
  }

  let stationType = doc.stationType;
  if (stationType !== "digital" && stationType !== "manual") {
    stationType = "digital";
    notes.push("type_defaulted");
  }

  let country = doc.bundu?.countryCode ?? doc.countryCode;
  if (typeof country === "string" && COUNTRY.test(country))
    country = country.toUpperCase();
  else {
    country = "ZW"; // what the legacy routes assumed
    notes.push("country_defaulted");
  }

  // Access is decided at creation. Anything that is not plainly active is
  // imported inactive: it is never switched on by an import.
  let status = "active";
  if (
    doc.status !== undefined &&
    doc.status !== null &&
    doc.status !== "active"
  ) {
    status = "inactive";
    notes.push("imported_inactive");
  }

  const item = { stationId, name, stationType };

  if (doc.hardware !== undefined && doc.hardware !== null) {
    const hardware = text(doc.hardware, { min: 1, max: 80 });
    if (hardware !== null) item.hardware = hardware;
    else if (String(doc.hardware).trim() !== "") notes.push("hardware_dropped");
  }
  item.lat = lat;
  item.lon = lon;
  if (doc.elevation !== undefined && doc.elevation !== null) {
    const elevation = number(doc.elevation);
    if (elevation !== null && elevation >= -430 && elevation <= 9000)
      item.elevation = elevation;
    else notes.push("elevation_dropped");
  }
  item.country = country;
  item.status = status;

  for (const [field, note] of [
    ["createdAt", "created_dropped"],
    ["lastObservationAt", "last_seen_dropped"],
  ]) {
    const raw = doc[field];
    if (raw === undefined || raw === null) continue;
    const iso = isoDate(raw);
    // A date ahead of the clock is bad data: the route would refuse the whole station.
    if (iso !== null && new Date(iso).getTime() <= now + MAX_SKEW_MS)
      item[field] = iso;
    else notes.push(note);
  }

  // Passed through as the very strings in the export. Never recomputed.
  item.credential = {
    algo: ALGO,
    hash: doc.ingestKeyHash,
    salt: doc.ingestKeySalt,
  };
  return { item, notes };
}

// --- the whole export ----------------------------------------------------------

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Every document to batches of at most `batchSize` import items, with counts.
 * `skipped` lists, per reason, what to look at: a masked station id, or the
 * position of a document that has no usable id (1-based; its content is never
 * echoed).
 */
export function transformAll(docs, { batchSize = DEFAULT_BATCH, now } = {}) {
  if (!Array.isArray(docs))
    throw new Error(
      "the export must be a JSON array: run mongoexport with --jsonArray",
    );
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH)
    throw new Error(`the batch size must be 1 to ${MAX_BATCH}`);

  const items = [];
  const seen = new Set();
  const skipped = {};
  const skippedWhere = {};
  const notes = {};

  docs.forEach((doc, index) => {
    const result = transformStation(doc, { now });
    let skip = result.skip;
    if (!skip && seen.has(result.item.stationId)) skip = "duplicate_station_id";
    if (skip) {
      bump(skipped, skip);
      const id = result.stationId ?? result.item?.stationId;
      (skippedWhere[skip] ??= []).push(
        id ? maskId(id) : `document #${index + 1}`,
      );
      return;
    }
    seen.add(result.item.stationId);
    for (const note of result.notes) bump(notes, note);
    items.push(result.item);
  });

  const batches = [];
  for (let i = 0; i < items.length; i += batchSize)
    batches.push(items.slice(i, i + batchSize));
  return {
    read: docs.length,
    importable: items.length,
    batches,
    skipped,
    skippedWhere,
    notes,
  };
}

// --- the command ---------------------------------------------------------------

const USAGE =
  "usage: node workers/scripts/stations-to-devices.mjs <stations.json> [--out <dir>] [--batch-size <1-100>]";

function parseArgs(argv) {
  const args = { file: null, out: "stations-import", batchSize: DEFAULT_BATCH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (a.startsWith("-")) return null;
    else if (args.file === null) args.file = a;
    else return null;
  }
  return args.file && args.out ? args : null;
}

/** Returns the process exit code. 0 done, 1 could not, 2 usage. */
export function main(argv, { log = console.log, error = console.error } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error(USAGE);
    return 2;
  }

  let docs;
  try {
    docs = JSON.parse(readFileSync(args.file, "utf8"));
  } catch (e) {
    // JSON.parse's own message quotes the file. This one never does.
    error(
      e && e.code
        ? `cannot read the export (${e.code})`
        : "the export is not valid JSON: run mongoexport with --jsonArray",
    );
    return 1;
  }

  let result;
  try {
    result = transformAll(docs, { batchSize: args.batchSize });
  } catch (e) {
    error(e.message);
    return 1;
  }

  log(`read ${result.read} documents`);
  log(`importable: ${result.importable}`);
  const skippedTotal = Object.values(result.skipped).reduce((a, b) => a + b, 0);
  log(`skipped: ${skippedTotal}`);
  for (const [reason, n] of Object.entries(result.skipped).sort())
    log(`  ${reason}: ${n} (${result.skippedWhere[reason].join(", ")})`);
  const notes = Object.entries(result.notes).sort();
  if (notes.length)
    log(
      `set aside on stations that are still imported: ${notes
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")}`,
    );

  if (result.importable === 0) {
    error("nothing to import: no files written");
    return 1;
  }

  mkdirSync(args.out, { recursive: true, mode: 0o700 });
  if (
    readdirSync(args.out).some((f) => /^stations-import-\d+\.json$/.test(f))
  ) {
    error(
      `${args.out} already holds batch files: use a new directory so old and new batches never mix`,
    );
    return 1;
  }
  const written = result.batches.map((batch, i) => {
    const file = join(
      args.out,
      `stations-import-${String(i + 1).padStart(3, "0")}.json`,
    );
    writeFileSync(file, `${JSON.stringify({ stations: batch }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return [file, batch.length];
  });
  log(
    `wrote ${written.length} batch file(s) of up to ${args.batchSize} stations (mode 0600). They hold key hashes: delete them when the import is done.`,
  );
  for (const [file, n] of written) log(`  ${file} (${n})`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
