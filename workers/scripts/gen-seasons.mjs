// Regenerates crates/weather-core/data/seasons.json from the app's season seed
// (the same documents /api/db-init writes to MongoDB `weather.seasons`), so
// the Workers can give a place its local season calendar with no database.
// Run from the repo root:
//   node --experimental-strip-types workers/scripts/gen-seasons.mjs
// CI runs it with --check and fails if the JSON is stale (compared as parsed
// JSON, so the formatter's layout does not matter).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const file = resolve(root, "workers/crates/weather-core/data/seasons.json");
const { SEASONS } = await import(
  pathToFileURL(resolve(root, "src/lib/seed-seasons.ts")).href
);

if (process.argv.includes("--check")) {
  let current;
  try {
    current = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    current = undefined;
  }
  if (JSON.stringify(current) !== JSON.stringify(SEASONS)) {
    console.error(
      `${relative(root, file)} is stale: run node --experimental-strip-types workers/scripts/gen-seasons.mjs, then prettier --write on it`,
    );
    process.exit(1);
  }
  console.log(`${relative(root, file)} is current (${SEASONS.length} rows)`);
} else {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(SEASONS, null, 2) + "\n");
  console.log(`wrote ${relative(root, file)} (${SEASONS.length} rows)`);
}
