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
}));
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

const outputs = [
  [out, JSON.stringify(rows, null, 2) + "\n", `${rows.length} locations`],
  [
    airportsOut,
    JSON.stringify(airports, null, 2) + "\n",
    `${airports.length} airports`,
  ],
];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [file, json, what] of outputs) {
    const current = readFileSync(file, "utf8");
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
