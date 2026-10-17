// Regenerates crates/weather-core/data/seed-locations.json from the app's
// seed list (src/lib/locations.ts + locations-global.ts), so the Workers
// resolve the same slugs the app does, and data/airports.json from the
// ICAO catalogue (src/lib/icao-codes.ts) for the aviation Worker. Run from
// the repo root:
//   node --experimental-strip-types workers/scripts/gen-seed-locations.mjs
// CI runs it with --check and fails if the JSON is stale.
import { writeFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { relative, resolve } from "node:path";
import { registerHooks } from "node:module";

// The app imports siblings without an extension ("./locations-global").
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const root = resolve(import.meta.dirname, "..", "..");
const out = resolve(
  root,
  "workers/crates/weather-core/data/seed-locations.json",
);
const { LOCATIONS } = await import(
  pathToFileURL(resolve(root, "src/lib/locations.ts")).href
);

const rows = LOCATIONS.map((l) => ({
  slug: l.slug,
  name: l.name,
  province: l.province,
  country: l.country ?? null,
  lat: l.lat,
  lon: l.lon,
  elevation: l.elevation,
  tags: l.tags ?? [],
}));
// Laid out as the org formatter (vite-plus / oxfmt, printWidth 80) leaves
// it: a tag list on one line when it fits, one tag per line when not.
const json =
  JSON.stringify(rows, null, 2).replace(
    /^( *)"tags": \[\n([^\]]*?)\n *\]/gm,
    (whole, indent, body) => {
      const tags = body.split(",\n").map((t) => t.trim());
      const line = `${indent}"tags": [${tags.join(", ")}]`;
      return line.length <= 80 ? line : whole;
    },
  ) + "\n";

const { AIRPORTS } = await import(
  pathToFileURL(resolve(root, "src/lib/icao-codes.ts")).href
);
const airportsOut = resolve(
  root,
  "workers/crates/weather-core/data/airports.json",
);
const airports = AIRPORTS.map((a) => ({
  icao: a.icao,
  name: a.name,
  lat: a.lat,
  lon: a.lon,
}));

// The pinned legacy → canonical slug table (src/lib/slug-migration-data.ts),
// for the Python backend and the Rust Workers: both accept the legacy and the
// canonical slug of a seed and key durable data by the legacy one.
const { SEED_SLUG_TABLE } = await import(
  pathToFileURL(resolve(root, "src/lib/slug-migration-data.ts")).href
);
const slugMigration =
  JSON.stringify(
    SEED_SLUG_TABLE.map(([legacy, canonical]) => ({ legacy, canonical })),
    null,
    2,
  ) + "\n";

const outputs = [
  [
    resolve(root, "workers/crates/weather-core/data/slug-migration.json"),
    slugMigration,
    `${SEED_SLUG_TABLE.length} slug pairs (Rust)`,
  ],
  [
    resolve(root, "api/py/data/slug_migration.json"),
    slugMigration,
    `${SEED_SLUG_TABLE.length} slug pairs (Python)`,
  ],
  [out, json, `${rows.length} locations`],
  [
    airportsOut,
    JSON.stringify(airports, null, 2) + "\n",
    `${airports.length} airports`,
  ],
];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [file, json, what] of outputs) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // A missing file is stale.
    }
    if (current !== json) {
      console.error(
        `${relative(root, file)} is stale: run node --experimental-strip-types workers/scripts/gen-seed-locations.mjs`,
      );
      stale = true;
    } else {
      console.log(`${relative(root, file)} is current (${what})`);
    }
  }
  if (stale) process.exit(1);
} else {
  for (const [file, json, what] of outputs) {
    writeFileSync(file, json);
    console.log(`wrote ${what}`);
  }
}
