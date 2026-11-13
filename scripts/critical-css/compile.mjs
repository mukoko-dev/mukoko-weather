// The app's stylesheet as the build makes it (issue #551): src/app/globals.css
// through Tailwind (the same PostCSS plugin the build uses), then Lightning CSS,
// which Next.js runs over it with the browser targets below (nesting flattened,
// colours and ranges down-levelled). Used by `generate.mjs` and by the test that
// holds the committed critical subset to the stylesheet as it is now.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { transform } from "lightningcss";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

/** Next.js's default browser support (chrome/edge/firefox 111, safari 16.4). */
export const TARGETS = {
  chrome: 111 << 16,
  edge: 111 << 16,
  firefox: 111 << 16,
  safari: (16 << 16) | (4 << 8),
};

export async function compileStylesheet({ root = ROOT } = {}) {
  const postcss = require("postcss");
  const tailwind = require("@tailwindcss/postcss");
  const from = join(root, "src", "app", "globals.css");
  const source = await readFile(from, "utf8");
  const built = await postcss([tailwind({ base: root })]).process(source, {
    from,
  });
  return transform({
    filename: "globals.css",
    code: Buffer.from(built.css),
    minify: true,
    // The build does the same: it warns about, and drops, the one rule Tailwind
    // makes from a class name quoted in prose (`rounded-[var(--radius-*)]`).
    errorRecovery: true,
    targets: TARGETS,
  }).code.toString();
}

/** Every attribute name a selector in the stylesheet asks about. */
export function attributeNamesIn(css) {
  const names = new Set();
  for (const m of css.matchAll(/\[\s*([a-zA-Z_][\w:.-]*)\s*(?:[~|^$*]?=|\])/g))
    names.add(m[1]);
  return [...names].sort();
}
