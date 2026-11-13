// Pick the critical subset of the app's stylesheet (issue #551).
//
// The rule: a style rule is critical when SOME selector in its list could match
// an element the first screen has, judged by the names alone. Every class, id,
// tag and attribute (and attribute value, for `=`) the selector asks for must
// be in the vocabulary of the real DOM (`record.mjs` writes it: the elements
// `/` and a place page build, light and dark, first visit and return visit, at
// several widths). Combinators, pseudo-classes (`:hover`, `:focus-visible`,
// `:not()`, `:has()`) and pseudo-elements are not judged: a rule that asks for
// a state is kept when its elements are there. That makes the subset a
// superset of what a browser's coverage would report, which is the safe
// direction: a rule too many costs bytes, a rule too few is a flash of the
// wrong style. The media and container conditions are not judged either, so a
// phone's subset still holds the desktop rules of the same elements.
//
// It is pure (text in, text out), so a test can run it: the committed subset
// must be what this function makes of the stylesheet as it is now.
import postcss from "postcss";
import { transform } from "lightningcss";

/** At-rules that hold other rules: dropped when nothing inside them is kept. */
const CONTAINERS = [
  "media",
  "supports",
  "container",
  "scope",
  "starting-style",
];

/**
 * @param {string} css  the whole stylesheet
 * @param {{ classes: string[], ids: string[], tags: string[], attributes: string[] }} vocabulary
 *   `attributes` holds `name` for an attribute that is present and `name=value`
 *   for one with that value.
 * @param {{ targets?: object }} [options]
 * @returns {{ css: string, rules: { kept: number, dropped: number } }}
 */
export function selectCritical(css, vocabulary, options = {}) {
  const classes = new Set(vocabulary.classes);
  const ids = new Set(vocabulary.ids);
  const tags = new Set(vocabulary.tags);
  const attributes = new Set(vocabulary.attributes);

  const compoundMayMatch = (component) => {
    switch (component.type) {
      case "class":
        return classes.has(component.name);
      case "id":
        return ids.has(component.name);
      case "type":
        return tags.has(component.name.toLowerCase());
      case "attribute": {
        const op = component.operation;
        if (op && op.operator === "equal")
          return attributes.has(`${component.name}=${op.value}`);
        return attributes.has(component.name);
      }
      case "pseudo-class":
        // :is() and :where() hold selectors that must themselves be possible.
        if (
          component.kind === "is" ||
          component.kind === "where" ||
          component.kind === "any"
        )
          return component.selectors.some(selectorMayMatch);
        return true;
      default:
        // universal, combinator, pseudo-element, nesting, namespace
        return true;
    }
  };
  const selectorMayMatch = (selector) => selector.every(compoundMayMatch);

  const keepStyle = (rule) => rule.value.selectors.some(selectorMayMatch);
  const run = (style, keyframes) =>
    transform({
      filename: "stylesheet.css",
      code: Buffer.from(css),
      minify: true,
      errorRecovery: true,
      targets: options.targets,
      visitor: { Rule: { style, keyframes } },
    }).code.toString();

  // Pass 1: the style rules, with every @keyframes set aside.
  const keyframeNames = new Set();
  const first = run(
    (rule) => (keepStyle(rule) ? undefined : []),
    (rule) => {
      keyframeNames.add(keyframeName(rule));
      return [];
    },
  );
  // A keyframes set is critical when a kept rule names it (in `animation`, or in
  // a custom property such as `--animate-spin: spin 1s linear infinite`).
  const usedKeyframes = new Set(
    [...keyframeNames].filter((name) =>
      new RegExp(`(^|[^\\w-])${escapeRegExp(name)}([^\\w-]|$)`).test(first),
    ),
  );

  // Pass 2: the same, keeping the keyframes the kept rules name, and counting.
  const rules = { kept: 0, dropped: 0 };
  const second = run(
    (rule) => {
      const keep = keepStyle(rule);
      rules[keep ? "kept" : "dropped"]++;
      return keep ? undefined : [];
    },
    (rule) => (usedKeyframes.has(keyframeName(rule)) ? undefined : []),
  );
  return { css: pruneEmpty(second), rules };
}

/**
 * Take out the media, supports and container blocks that lost every rule in
 * them. (A `@layer` block stays even when empty: the layers are declared in the
 * order the whole sheet has them, and the sheet that follows would otherwise
 * decide the order.)
 */
function pruneEmpty(css) {
  const root = postcss.parse(css);
  let removed = true;
  while (removed) {
    removed = false;
    root.walkAtRules((rule) => {
      if (
        rule.nodes &&
        rule.nodes.length === 0 &&
        CONTAINERS.includes(rule.name)
      ) {
        rule.remove();
        removed = true;
      }
    });
  }
  return root.toString();
}

function keyframeName(rule) {
  const name = rule.value.name;
  return typeof name === "string" ? name : (name.value ?? String(name));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
