// Record the vocabulary of the first screen's real DOM (issue #551): every tag,
// class, id and attribute the elements of `/` and a place page carry from the
// first byte to a few seconds after the weather is on screen. `select.mjs`
// turns it into the critical subset of the stylesheet.
//
// A browser is needed, so this is run by hand when the first screen's markup
// changes (the test fails and says so), never in CI:
//
//   npm run build && npx next start -p 3151        # listens on every address
//   BASE=http://<this machine's address>:3151 \
//   CHROME_PATH=/path/to/chrome-linux64/chrome \
//   node scripts/critical-css/record.mjs
//
// What it visits: `/` and a place page (`/harare`) and a place that does not
// exist (the page a mistyped address shows), each in light and dark, as a first
// visit and as a return visit (the stored place and forecast are on the device),
// at 360, 393, 412, 768 and 1280 px wide. The network is answered by the script
// (`mockNetwork`: the forecast of memory-harness.mjs), so no provider is asked.
// A MutationObserver installed before the page's own scripts notes every element
// that is ever added and every attribute that ever changes, so a skeleton that
// is replaced, a sky that arrives after the weather and a theme that settles
// are all in. Nothing is scrolled or clicked: this is the first screen, what is
// built when the weather is on screen, not what a tap opens later.
//
// Output: src/lib/critical-css/vocabulary.json, sorted, one entry per line, so a
// change to the markup reads as a short diff. Nothing personal is in it: names
// of tags, classes and attributes and the few ids a rule asks about, never text,
// hrefs or the ids of people or places.
import { createRequire } from "node:module";
import { BASE } from "../browser-check/harness.mjs";
import { mockNetwork } from "../browser-check/memory-harness.mjs";
import { compileStylesheet, attributeNamesIn } from "./compile.mjs";
import {
  VOCABULARY_PATH,
  slimVocabulary,
  writeVocabulary,
} from "./vocabulary.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const WIDTHS = [
  [360, 740],
  [393, 852],
  [412, 915],
  [768, 1024],
  [1280, 800],
];
const SCHEMES = ["light", "dark"];
const ROUTES = ["/", "/harare", "/no-such-place-zz"];
const SETTLE_MS = Number(process.env.SETTLE ?? 3500);

/** Installed before any page script: notes what the DOM ever holds. */
const INIT = (attributeNames) => {
  const names = new Set(attributeNames);
  const seen = {
    tags: new Set(),
    classes: new Set(),
    ids: new Set(),
    attributes: new Set(),
  };
  window.__vocabulary = seen;
  const note = (el) => {
    if (el.nodeType !== 1) return;
    seen.tags.add(el.localName);
    for (const c of el.classList) seen.classes.add(c);
    if (el.id) seen.ids.add(el.id);
    for (const a of el.attributes) {
      if (!names.has(a.name)) continue;
      seen.attributes.add(a.name);
      if (a.value.length <= 80) seen.attributes.add(`${a.name}=${a.value}`);
    }
  };
  const walk = (node) => {
    note(node);
    if (node.querySelectorAll)
      for (const el of node.querySelectorAll("*")) note(el);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "childList") r.addedNodes.forEach(walk);
      else note(r.target);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true });
  document.addEventListener("DOMContentLoaded", () => walk(document));
};

async function visit(context, route, attributeNames, into) {
  const page = await context.newPage();
  await page.addInitScript(INIT, attributeNames);
  await page.goto(BASE + route, { waitUntil: "commit" });
  // The weather is on screen: a place that exists draws the real hero; an
  // unknown place draws its own page, so wait for the load event there.
  await page
    .waitForSelector("[data-sky-hero]:not([data-skeleton]), main", {
      timeout: 20000,
    })
    .catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  const seen = await page.evaluate(() => {
    document.querySelectorAll("*").forEach((el) => {
      window.__vocabulary.tags.add(el.localName);
    });
    return Object.fromEntries(
      Object.entries(window.__vocabulary).map(([k, v]) => [k, [...v]]),
    );
  });
  for (const k of Object.keys(into)) for (const v of seen[k]) into[k].add(v);
  await page.close();
}

const css = await compileStylesheet();
const attributeNames = attributeNamesIn(css);
const into = {
  tags: new Set(),
  classes: new Set(),
  ids: new Set(),
  attributes: new Set(),
};
const launched = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: [`--unsafely-treat-insecure-origin-as-secure=${new URL(BASE).origin}`],
});
try {
  for (const [width, height] of WIDTHS)
    for (const colorScheme of SCHEMES) {
      const context = await launched.newContext({
        ...devices["Pixel 5"],
        viewport: { width, height },
        colorScheme,
        serviceWorkers: "allow",
      });
      await mockNetwork(context);
      for (const route of ROUTES) {
        await visit(context, route, attributeNames, into); // first visit
        await visit(context, route, attributeNames, into); // return visit
      }
      await context.close();
      console.error(
        `${width}x${height} ${colorScheme}: ${into.classes.size} classes`,
      );
    }
} finally {
  await launched.close();
}

const vocabulary = slimVocabulary(into, css);
await writeVocabulary(vocabulary);
console.log(
  `wrote ${VOCABULARY_PATH}: ${vocabulary.tags.length} tags, ${vocabulary.classes.length} classes, ${vocabulary.ids.length} ids, ${vocabulary.attributes.length} attributes`,
);
