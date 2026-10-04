// One-off migration: turn a `mongoexport --jsonArray` of weather.stations
// into SQL for the D1 database `mukoko-weather`. It keeps each station's
// ingest-key hash and salt, so registered stations keep working with the
// keys they already have. This only transforms a file: it connects to no
// database. Run from the repo root:
//   node workers/scripts/stations-to-d1.mjs stations.json > stations.sql
//   (cd workers/stations && npx wrangler d1 execute mukoko-weather --remote --file ../../stations.sql)
// Delete both files afterwards: they contain key hashes.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error(
    "usage: node workers/scripts/stations-to-d1.mjs <stations.json>",
  );
  process.exit(2);
}

const sql = (v) =>
  v === null || v === undefined || Number.isNaN(v)
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : `'${String(v).replaceAll("'", "''")}'`;
const ms = (v) => {
  const raw = v && typeof v === "object" && "$date" in v ? v.$date : v;
  const t = raw === null || raw === undefined ? NaN : new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
};

const docs = JSON.parse(readFileSync(file, "utf8"));
let written = 0;
for (const d of docs) {
  if (
    !/^mws-[a-f0-9]{8}$/.test(d.stationId ?? "") ||
    !d.ingestKeyHash ||
    !d.ingestKeySalt
  ) {
    console.error(
      `skipped: ${d.stationId ?? "(no stationId)"} (no id or key hash)`,
    );
    continue;
  }
  const [lon, lat] = d.location?.coordinates ?? [d.lon, d.lat];
  const created = ms(d.createdAt) ?? Date.now();
  const row = [
    d.stationId,
    d.name ?? d.stationId,
    Number(lat),
    Number(lon),
    d.elevation ?? null,
    d.stationType ?? "digital",
    d.hardware ?? null,
    (d.bundu?.countryCode ?? d.countryCode ?? "ZW").toUpperCase(),
    d.status ?? "active",
    d.ingestKeyHash,
    d.ingestKeySalt,
    ms(d.lastObservationAt),
    created,
    ms(d.updatedAt) ?? created,
  ];
  console.log(
    "INSERT OR IGNORE INTO stations (station_id, name, lat, lon, elevation, station_type, hardware, " +
      "country_code, status, ingest_key_hash, ingest_key_salt, last_observation_at, created_at, updated_at) " +
      `VALUES (${row.map(sql).join(", ")});`,
  );
  written++;
}
console.error(`${written} of ${docs.length} stations written`);
