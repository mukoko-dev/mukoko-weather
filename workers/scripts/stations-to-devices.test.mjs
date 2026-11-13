// Tests for stations-to-devices.mjs (B3, #561): `node --test workers/scripts/`.
//
// Every station, name, hash and salt here is invented (the fixture's hash is
// "fa4e" repeated, its salts say FAKE): no real station data, no real digest.
// The one computed digest (below) is made from a fake key, to show a hash passes
// through the transform as the very same string and still verifies.
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ALGO,
  DEFAULT_BATCH,
  MAX_BATCH,
  main,
  maskId,
  transformAll,
  transformStation,
} from "./stations-to-devices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "stations-to-devices.mjs");
const FIXTURE = join(here, "fixtures", "stations-export.fake.json");
const NOW = Date.parse("2026-11-13T09:00:00Z");

const FAKE_KEY = "fake-key-not-a-real-one";
const FAKE_SALT = "FAKE-SALT-for-the-computed-digest";
const FAKE_HASH = pbkdf2Sync(
  FAKE_KEY,
  FAKE_SALT,
  60_000,
  32,
  "sha256",
).toString("hex");

/** A legacy weather.stations document, as the Python route wrote it and mongoexport prints it. */
function legacy(overrides = {}) {
  return {
    _id: "00000000-0000-4000-8000-0000000000aa",
    _schemaVersion: "v3.1",
    stationId: "mws-0a1b2c3d",
    name: "FAKE Test Station",
    location: { type: "Point", coordinates: [20, -10] },
    lat: -10,
    lon: 20,
    elevation: 1000,
    stationType: "digital",
    hardware: "FAKE Hardware",
    status: "active",
    ingestKeyHash: FAKE_HASH,
    ingestKeySalt: FAKE_SALT,
    lastObservationAt: { $date: "2026-11-12T17:40:00Z" },
    createdAt: { $date: "2026-05-04T08:15:00Z" },
    bundu: { countryCode: "ZW" },
    ...overrides,
  };
}

function station(overrides) {
  return transformStation(legacy(overrides), { now: NOW });
}

/** A scratch directory outside the repo, removed afterwards. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "stations-to-devices-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    ...options,
  });
}

// --- one station ---------------------------------------------------------------

test("a legacy station becomes the import route's item", () => {
  const { item, notes } = station();
  assert.deepEqual(item, {
    stationId: "mws-0a1b2c3d",
    name: "FAKE Test Station",
    stationType: "digital",
    hardware: "FAKE Hardware",
    lat: -10,
    lon: 20,
    elevation: 1000,
    country: "ZW",
    status: "active",
    createdAt: "2026-05-04T08:15:00.000Z",
    lastObservationAt: "2026-11-12T17:40:00.000Z",
    credential: { algo: ALGO, hash: FAKE_HASH, salt: FAKE_SALT },
  });
  assert.deepEqual(notes, []);
});

test("the hash and salt pass through as the very same strings, and still verify", () => {
  const { item } = station();
  assert.equal(item.credential.hash, FAKE_HASH);
  assert.equal(item.credential.salt, FAKE_SALT);
  // The scheme the API checks: PBKDF2-HMAC-SHA256, 60,000 iterations, the salt as UTF-8.
  assert.equal(
    pbkdf2Sync(FAKE_KEY, item.credential.salt, 60_000, 32, "sha256").toString(
      "hex",
    ),
    item.credential.hash,
  );
  // The cross-language vector the Python and Rust implementations pin.
  assert.equal(
    pbkdf2Sync("test-key", "salt", 60_000, 32, "sha256").toString("hex"),
    "568fdcdb1ed66c4ebddc9e59860649a395968f11bddc619037ee0dc7df0742e9",
  );
});

test("coordinates are read in GeoJSON order, with lat and lon as the fallback", () => {
  assert.deepEqual(
    [
      station({ location: { coordinates: [31, -17] }, lat: 0, lon: 0 }).item
        .lon,
      station({ location: { coordinates: [31, -17] }, lat: 0, lon: 0 }).item
        .lat,
    ],
    [31, -17],
  );
  const flat = station({ location: undefined, lat: -17.5, lon: 31.5 }).item;
  assert.deepEqual([flat.lat, flat.lon], [-17.5, 31.5]);
});

test("Extended JSON numbers and dates are read", () => {
  const { item } = station({
    location: undefined,
    lat: { $numberDouble: "-17.25" },
    lon: { $numberDouble: "31.75" },
    elevation: { $numberInt: "1200" },
    createdAt: { $date: { $numberLong: "1777882500000" } },
    lastObservationAt: "2026-11-12T17:40:00Z",
  });
  assert.deepEqual([item.lat, item.lon, item.elevation], [-17.25, 31.75, 1200]);
  assert.equal(item.createdAt, "2026-05-04T08:15:00.000Z");
  assert.equal(item.lastObservationAt, "2026-11-12T17:40:00.000Z");
});

test("a station without a stationId or a key hash is skipped, with its reason", () => {
  const cases = [
    [null, "not_an_object"],
    ["text", "not_an_object"],
    [[1, 2], "not_an_object"],
    [{ slug: "seed", stationName: "the seed document" }, "no_station_id"],
    [{ ...legacy(), stationId: "MWS-0A1B2C3D" }, "no_station_id"],
    [{ ...legacy(), stationId: "mws-0a1b2c3" }, "no_station_id"],
    [{ ...legacy(), ingestKeyHash: undefined }, "no_key"],
    [{ ...legacy(), ingestKeySalt: "" }, "no_key"],
    // Forms the API would never verify or accept.
    [{ ...legacy(), ingestKeyHash: FAKE_HASH.toUpperCase() }, "bad_hash"],
    [{ ...legacy(), ingestKeyHash: FAKE_HASH.slice(2) }, "bad_hash"],
    [{ ...legacy(), ingestKeyHash: 12345 }, "bad_hash"],
    [{ ...legacy(), ingestKeySalt: "has a space" }, "bad_salt"],
    [{ ...legacy(), ingestKeySalt: "x".repeat(129) }, "bad_salt"],
    [{ ...legacy(), location: undefined, lat: 91 }, "bad_position"],
    [{ ...legacy(), location: undefined, lon: -181 }, "bad_position"],
    [{ ...legacy(), location: undefined, lat: undefined }, "bad_position"],
    [{ ...legacy(), location: { coordinates: ["x", "y"] } }, "bad_position"],
  ];
  for (const [doc, reason] of cases)
    assert.equal(transformStation(doc, { now: NOW }).skip, reason, reason);
});

test("an optional thing that is wrong is set aside, so the station keeps its key", () => {
  const { item, notes } = station({
    name: "x",
    stationType: "robot",
    hardware: "h".repeat(81),
    elevation: 9001,
    bundu: { countryCode: "ZWE" },
    createdAt: { $date: "2999-01-01T00:00:00Z" },
    lastObservationAt: "not a date",
  });
  assert.equal(item.name, "mws-0a1b2c3d");
  assert.equal(item.stationType, "digital");
  assert.equal(item.country, "ZW");
  for (const absent of [
    "hardware",
    "elevation",
    "createdAt",
    "lastObservationAt",
  ])
    assert.ok(!(absent in item), absent);
  assert.deepEqual(notes.sort(), [
    "country_defaulted",
    "created_dropped",
    "elevation_dropped",
    "hardware_dropped",
    "last_seen_dropped",
    "name_defaulted",
    "type_defaulted",
  ]);
  assert.equal(item.credential.hash, FAKE_HASH);
});

test("fields the document does not carry are left out, not nulled", () => {
  const { item } = station({
    hardware: null,
    elevation: null,
    lastObservationAt: null,
    createdAt: undefined,
    stationType: "manual",
    bundu: { countryCode: "zm" },
  });
  for (const absent of [
    "hardware",
    "elevation",
    "lastObservationAt",
    "createdAt",
  ])
    assert.ok(!(absent in item), absent);
  assert.equal(item.stationType, "manual");
  assert.equal(item.country, "ZM");
});

test("a station that is not plainly active is imported inactive, never switched on", () => {
  for (const status of ["inactive", "maintenance", "decommissioned", "weird"]) {
    const { item, notes } = station({ status });
    assert.equal(item.status, "inactive", status);
    assert.deepEqual(notes, ["imported_inactive"]);
  }
  assert.equal(station({ status: "active" }).item.status, "active");
  assert.equal(station({ status: undefined }).item.status, "active");
});

test("the name is trimmed, and a control character defaults it", () => {
  assert.equal(station({ name: "  Two Words  " }).item.name, "Two Words");
  assert.equal(station({ name: "bad\u0000name" }).item.name, "mws-0a1b2c3d");
});

// --- the whole export ----------------------------------------------------------

test("a duplicate stationId is skipped: the first one wins", () => {
  const first = legacy({ name: "FAKE First" });
  const second = legacy({
    name: "FAKE Second",
    ingestKeySalt: "FAKE-OTHER-SALT",
  });
  const out = transformAll([first, second], { now: NOW });
  assert.equal(out.importable, 1);
  assert.equal(out.batches[0][0].name, "FAKE First");
  assert.deepEqual(out.skipped, { duplicate_station_id: 1 });
});

test("batches keep the export's order and never exceed the batch size", () => {
  const docs = Array.from({ length: 120 }, (_, i) =>
    legacy({ stationId: `mws-${i.toString(16).padStart(8, "0")}` }),
  );
  const out = transformAll(docs, { batchSize: 50, now: NOW });
  assert.deepEqual(
    out.batches.map((b) => b.length),
    [50, 50, 20],
  );
  assert.deepEqual(
    out.batches.flat().map((s) => s.stationId),
    docs.map((d) => d.stationId),
  );
  assert.equal(DEFAULT_BATCH, 50);
  assert.equal(
    transformAll(docs, { batchSize: MAX_BATCH, now: NOW }).batches.length,
    2,
  );
  for (const bad of [0, -1, 101, 1.5, NaN])
    assert.throws(() => transformAll(docs, { batchSize: bad }), /batch size/);
});

test("anything but an array is refused", () => {
  assert.throws(() => transformAll({ stations: [] }), /JSON array/);
  assert.throws(() => transformAll("x"), /JSON array/);
});

test("masked ids show four characters of eight, and only for station ids", () => {
  assert.equal(maskId("mws-0a1b2c3d"), "mws-0a****3d");
  assert.equal(maskId("not an id with a secret in it"), "(not a station id)");
  assert.equal(maskId(undefined), "(not a station id)");
});

// --- the command, on the fixture ----------------------------------------------------

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const secrets = [
  ...new Set(fixture.flatMap((d) => [d.ingestKeyHash, d.ingestKeySalt])),
].filter(Boolean);
const names = fixture.flatMap((d) => [d.name, d.stationName]).filter(Boolean);

test("the command writes batch files and prints only counts and masked ids", (t) => {
  const out = join(scratch(t), "batches");
  const r = run([FIXTURE, "--out", out, "--batch-size", "2"]);
  assert.equal(r.status, 0, r.stderr);

  const printed = r.stdout + r.stderr;
  for (const secret of secrets) assert.ok(!printed.includes(secret), secret);
  for (const name of names) assert.ok(!printed.includes(name), name);
  assert.ok(
    !/mws-fa4e000\d/.test(printed),
    "an unmasked station id was printed",
  );
  assert.match(printed, /read 9 documents/);
  assert.match(printed, /importable: 4/);
  assert.match(printed, /skipped: 5/);
  for (const reason of [
    "no_station_id: 1 (document #4)",
    "no_key: 1 (mws-fa****05)",
    "bad_hash: 1 (mws-fa****06)",
    "bad_position: 1 (mws-fa****07)",
    "duplicate_station_id: 1 (mws-fa****01)",
  ])
    assert.ok(printed.includes(reason), reason);
  assert.match(printed, /imported_inactive 1/);
  assert.match(printed, /delete them when the import is done/);

  // Four stations in batches of two.
  const files = readdirSync(out).sort();
  assert.deepEqual(files, [
    "stations-import-001.json",
    "stations-import-002.json",
  ]);
  const batches = files.map((f) =>
    JSON.parse(readFileSync(join(out, f), "utf8")),
  );
  for (const batch of batches)
    assert.deepEqual(Object.keys(batch), ["stations"]);
  const items = batches.flatMap((b) => b.stations);
  assert.deepEqual(
    items.map((s) => s.stationId),
    ["mws-fa4e0001", "mws-fa4e0002", "mws-fa4e0003", "mws-fa4e0009"],
  );
  // The hashes are exactly the export's, and the files are the owner's alone.
  assert.equal(items[0].credential.hash, fixture[0].ingestKeyHash);
  assert.equal(items[0].credential.salt, fixture[0].ingestKeySalt);
  assert.equal(items[2].status, "inactive");
  assert.equal(items[2].lon, 22.5);
  if (process.platform !== "win32") {
    for (const f of files)
      assert.equal(statSync(join(out, f)).mode & 0o777, 0o600, f);
    assert.equal(statSync(out).mode & 0o777, 0o700);
  }
});

// The request body of POST /v1/stations/import (nyuchi/nyuchi-api#544, its OpenAPI
// `ImportStationIn`). If the route's contract moves, this is the test that says so.
const ROUTE = {
  required: ["stationId", "name", "lat", "lon", "credential"],
  optional: [
    "stationType",
    "hardware",
    "elevation",
    "country",
    "status",
    "createdAt",
    "lastObservationAt",
  ],
  credential: ["algo", "hash", "salt"],
};

test("every item has the route's fields, and no others", () => {
  const { batches } = transformAll(fixture, { now: NOW });
  assert.ok(batches.length > 0);
  for (const item of batches.flat()) {
    const keys = Object.keys(item);
    for (const k of ROUTE.required) assert.ok(keys.includes(k), k);
    for (const k of keys)
      assert.ok([...ROUTE.required, ...ROUTE.optional].includes(k), k);
    assert.deepEqual(Object.keys(item.credential).sort(), ROUTE.credential);
    assert.match(item.stationId, /^mws-[a-f0-9]{8}$/);
    assert.match(item.credential.hash, /^[0-9a-f]{64}$/);
    assert.match(item.credential.salt, /^[\x21-\x7e]{1,128}$/);
    assert.equal(item.credential.algo, "pbkdf2-sha256-60000");
    assert.ok(item.name.length >= 2 && item.name.length <= 80);
    assert.ok(["digital", "manual"].includes(item.stationType));
    assert.ok(["active", "inactive"].includes(item.status));
    assert.match(item.country, /^[A-Z]{2}$/);
    for (const k of ["createdAt", "lastObservationAt"])
      if (k in item) assert.match(item[k], /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  }
});

test("the command refuses to mix a new run with an old one's batch files", (t) => {
  const out = join(scratch(t), "batches");
  assert.equal(run([FIXTURE, "--out", out]).status, 0);
  const again = run([FIXTURE, "--out", out]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already holds batch files/);
  assert.deepEqual(readdirSync(out), ["stations-import-001.json"]);
});

test("usage errors exit 2 and write nothing", (t) => {
  const dir = scratch(t);
  for (const args of [
    [],
    ["--out", join(dir, "x")],
    [FIXTURE, "extra-positional"],
    [FIXTURE, "--unknown"],
    [FIXTURE, "--out"],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage:/);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("an unreadable or invalid export never has its content echoed", (t) => {
  const dir = scratch(t);
  const bad = join(dir, "not-json.txt");
  writeFileSync(bad, 'SECRET-LOOKING-VALUE {"a": ');
  const asObject = join(dir, "object.json");
  writeFileSync(asObject, JSON.stringify({ SECRET: FAKE_HASH }));

  for (const [file, expected] of [
    [bad, /not valid JSON/],
    [asObject, /JSON array/],
    [join(dir, "missing.json"), /cannot read the export \(ENOENT\)/],
  ]) {
    const r = run([file, "--out", join(dir, "out")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, expected);
    assert.ok(!(r.stdout + r.stderr).includes("SECRET"));
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_HASH));
  }
  assert.ok(!existsSync(join(dir, "out")));
});

test("an export with nothing importable writes no files", (t) => {
  const dir = scratch(t);
  const file = join(dir, "empty.json");
  writeFileSync(
    file,
    JSON.stringify([{ slug: "seed" }, { stationId: "mws-0a1b2c3d" }]),
  );
  const out = join(dir, "out");
  const r = run([file, "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing to import/);
  assert.ok(!existsSync(out));
});

test("main can be driven in-process, and prints through what it is given", (t) => {
  const dir = scratch(t);
  const lines = [];
  const code = main([FIXTURE, "--out", join(dir, "b")], {
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.startsWith("importable: 4")));
});
