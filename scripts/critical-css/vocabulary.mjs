// The vocabulary file (issue #551): what `record.mjs` saw in the first screen's
// DOM, cut down to what the stylesheet can ask about, and written one entry per
// line so a change in the markup reads as a short diff.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VOCABULARY_PATH = join(
  ROOT,
  "src",
  "lib",
  "critical-css",
  "vocabulary.json",
);

/** Every `#id` a selector in the stylesheet asks about. */
export function idsIn(css) {
  const ids = new Set();
  for (const m of css.matchAll(/#([a-zA-Z_][\w-]*)(?=[\s,.:[>+~){]|$)/g))
    ids.add(m[1]);
  return ids;
}

/** Every `name=value` an equality attribute selector in the stylesheet asks about. */
export function attributePairsIn(css) {
  const pairs = new Set();
  for (const m of css.matchAll(
    /\[\s*([a-zA-Z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+))/g,
  ))
    pairs.add(`${m[1]}=${m[2] ?? m[3] ?? m[4]}`);
  return pairs;
}

/**
 * Keep only what a selector could ask about. The ids of the page's elements
 * (headings carry a place's slug) are kept only when the stylesheet has a `#id`
 * rule for them; an attribute is kept by name, and by name=value only when an
 * equality selector in the stylesheet asks for that very value (a `title` that
 * names a place is never one).
 */
export function slimVocabulary(raw, css) {
  const wanted = idsIn(css);
  const pairs = attributePairsIn(css);
  return {
    tags: [...raw.tags].sort(),
    classes: [...raw.classes].sort(),
    ids: [...raw.ids].filter((id) => wanted.has(id)).sort(),
    attributes: [...raw.attributes]
      .filter((a) => !a.includes("=") || pairs.has(a))
      .sort(),
  };
}

export async function writeVocabulary(vocabulary) {
  const lines = (list) =>
    list.length
      ? `[\n${list.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]`
      : "[]";
  const note =
    "Recorded by scripts/critical-css/record.mjs from the first screen's real DOM. Do not edit by hand.";
  await mkdir(dirname(VOCABULARY_PATH), { recursive: true });
  await writeFile(
    VOCABULARY_PATH,
    `{\n  "note": ${JSON.stringify(note)},\n  "tags": ${lines(vocabulary.tags)},\n  "classes": ${lines(vocabulary.classes)},\n  "ids": ${lines(vocabulary.ids)},\n  "attributes": ${lines(vocabulary.attributes)}\n}\n`,
  );
}
