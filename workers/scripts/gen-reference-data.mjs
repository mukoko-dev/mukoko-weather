// Regenerates crates/weather-core/data/reference/*.json from the app's seed
// files (the same documents /api/db-init writes to MongoDB), so the Workers
// serve the reference data (activities, categories, suitability rules, tags,
// regions, AI prompts and suggested prompt rules) with no database. Run from
// the repo root:
//   node --experimental-strip-types workers/scripts/gen-reference-data.mjs
// CI runs it with --check and fails if the JSON is stale (compared as parsed
// JSON, so the formatter's layout does not matter).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { relative, resolve } from "node:path";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const root = resolve(import.meta.dirname, "..", "..");
const dir = resolve(root, "workers/crates/weather-core/data/reference");
const load = (f) => import(pathToFileURL(resolve(root, "src/lib", f)).href);

const [acts, cats, rules, tags, regions, prompts] = await Promise.all([
  load("activities.ts"),
  load("seed-categories.ts"),
  load("seed-suitability-rules.ts"),
  load("seed-tags.ts"),
  load("seed-regions.ts"),
  load("seed-ai-prompts.ts"),
]);

const outputs = {
  "activities.json": acts.ACTIVITIES,
  "categories.json": cats.CATEGORIES,
  "suitability-rules.json": rules.SUITABILITY_RULES,
  "tags.json": tags.TAGS,
  "regions.json": regions.REGIONS,
  "ai-prompts.json": prompts.AI_PROMPTS,
  "ai-suggested-rules.json": prompts.AI_SUGGESTED_PROMPT_RULES,
};

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [name, value] of Object.entries(outputs)) {
    const file = resolve(dir, name);
    let current;
    try {
      current = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      current = undefined;
    }
    if (JSON.stringify(current) !== JSON.stringify(value)) {
      console.error(
        `${relative(root, file)} is stale: run node --experimental-strip-types workers/scripts/gen-reference-data.mjs, then prettier --write on it`,
      );
      stale = true;
    } else {
      console.log(`${relative(root, file)} is current (${value.length} rows)`);
    }
  }
  if (stale) process.exit(1);
} else {
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(outputs)) {
    writeFileSync(resolve(dir, name), JSON.stringify(value, null, 2) + "\n");
    console.log(`wrote ${name} (${value.length} rows)`);
  }
}
