/**
 * Text fitting for the OG card. Pure: no fonts are loaded here. Widths are
 * estimated from the font size (Noto Serif Bold averages a little over half an
 * em per glyph), then the real renderer clamps lines as a second guard, so an
 * estimate that is a little off costs an ellipsis, never an overflow.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** User-perceived characters: "é" typed as e + U+0301 is one. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** C0 and C1 controls, zero-width and bidi marks and overrides, and isolates. */
const CONTROL = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
  "g",
);

/** Collapse whitespace; drop control and bidi-override characters. */
export function clean(text: string): string {
  return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** At most `max` characters, ending in an ellipsis when it had to cut. */
export function truncate(text: string, max: number): string {
  const g = graphemes(clean(text));
  if (g.length <= max) return g.join("");
  return `${g
    .slice(0, Math.max(0, max - 1))
    .join("")
    .trimEnd()}…`;
}

/**
 * Whether the bundled fonts (Noto Sans and Serif: Latin, Latin Extended and
 * Vietnamese) can draw every character. Other scripts would be empty boxes.
 */
export function isRenderable(text: string): boolean {
  return /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u.test(
    text,
  );
}

/** "port-elizabeth-za" is not a name, but it is better than empty boxes. */
export function nameFromSlug(slug: string): string {
  return slug
    .replace(/-[a-z]{2}$/, "")
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Average glyph width in em for bold serif text with capitals. */
const EM = 0.6;

function lineCount(text: string, size: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (size * EM)));
  let lines = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    const len = graphemes(word).length;
    if (len > perLine) {
      // An unbreakable word is broken at the edge (wordBreak: break-word).
      if (used > 0) lines += 1;
      const extra = Math.ceil(len / perLine) - 1;
      lines += extra;
      used = len - extra * perLine;
    } else if (used === 0) {
      used = len;
    } else if (used + 1 + len <= perLine) {
      used += 1 + len;
    } else {
      lines += 1;
      used = len;
    }
  }
  return lines;
}

export interface TitleFit {
  text: string;
  size: number;
  maxLines: number;
}

const STEPS: readonly (readonly [size: number, lines: number])[] = [
  [88, 2],
  [76, 2],
  [66, 2],
  [56, 3],
  [48, 3],
];

/**
 * The largest size at which `title` fits in `width` px; when even the
 * smallest does not, the title is cut so it does.
 */
export function fitTitle(title: string, width: number): TitleFit {
  const text = clean(title) || "mukoko weather";
  for (const [size, maxLines] of STEPS) {
    if (lineCount(text, size, width) <= maxLines) {
      return { text, size, maxLines };
    }
  }
  const [size, maxLines] = STEPS[STEPS.length - 1];
  const capacity = Math.floor(width / (size * EM)) * maxLines - 2;
  return { text: truncate(text, capacity), size, maxLines };
}
