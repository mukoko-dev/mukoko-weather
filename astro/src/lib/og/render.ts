/**
 * Draws a card to PNG at build time: satori (element tree to SVG) and sharp
 * (SVG to PNG). BUILD ONLY. It reads files and loads a native module, so it is
 * imported by the `/og/[...slug].png` endpoint, which is prerendered, and by
 * nothing a page ships; `og-dist.test.ts` fails when `node:` or either
 * library appears in the built output.
 *
 * Fonts are Noto Sans and Noto Serif from the Fontsource packages, read from
 * node_modules (never fetched). The mark is `public/logo-dark.svg`, the
 * Seed of Life exactly as the file is, embedded unchanged.
 *
 * Results are cached on disk under node_modules/.cache/mukoko-og, keyed on a
 * hash of everything that can change the picture, so a rebuild redraws only
 * the cards whose text, template, fonts or mark changed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import satori from "satori";
import sharp from "sharp";
import { CARD, buildCard, type CardSpec } from "./card";
import { GROUND } from "./colors";

/** Bump when the drawing code changes in a way the hash cannot see. */
const TEMPLATE_VERSION = 1;

// The build runs from astro/ (npm run build, the Astro root).
const ROOT = process.cwd();

function fromRoot(...parts: string[]): string {
  const path = join(ROOT, ...parts);
  if (!existsSync(path)) {
    throw new Error(
      `og: ${path} is missing. Run the build from astro/ after npm ci.`,
    );
  }
  return path;
}

const FONT_FILES = [
  ["Noto Sans", 400, "noto-sans"],
  ["Noto Sans", 600, "noto-sans"],
  ["Noto Serif", 700, "noto-serif"],
] as const;
// Latin first, then the subsets that cover accents and Vietnamese: satori
// falls back across fonts of one family, glyph by glyph.
const SUBSETS = ["latin", "latin-ext", "vietnamese"] as const;

let loaded: {
  fonts: {
    name: string;
    data: Buffer;
    weight: 400 | 600 | 700;
    style: "normal";
  }[];
  mark: string;
  fingerprint: string;
} | null = null;

function assets() {
  if (loaded) return loaded;
  const hash = createHash("sha256");
  const fonts = FONT_FILES.flatMap(([name, weight, pkg]) =>
    SUBSETS.map((subset) => {
      const data = readFileSync(
        fromRoot(
          "node_modules",
          "@fontsource",
          pkg,
          "files",
          `${pkg}-${subset}-${weight}-normal.woff`,
        ),
      );
      hash.update(data);
      // One family name per subset, joined in a font-family list by the card
      // (FAMILY below): satori falls back across that list glyph by glyph,
      // which it does not do reliably across same-named subsets.
      return {
        name: subset === "latin" ? name : `${name} ${subset}`,
        data,
        weight,
        style: "normal" as const,
      };
    }),
  );
  // The mark lives with the Next.js app's public files; astro/ is its sibling.
  const markBytes = readFileSync(fromRoot("..", "public", "logo-dark.svg"));
  hash.update(markBytes);
  hash.update(String(TEMPLATE_VERSION));
  loaded = {
    fonts,
    mark: `data:image/svg+xml;base64,${markBytes.toString("base64")}`,
    fingerprint: hash.digest("hex"),
  };
  return loaded;
}

const CACHE_DIR = join(ROOT, "node_modules", ".cache", "mukoko-og");

export interface RenderStats {
  drawn: number;
  cached: number;
}
export const stats: RenderStats = { drawn: 0, cached: 0 };

/** The card as SVG (what satori draws), before it is rasterised. */
export async function drawSvg(spec: CardSpec): Promise<string> {
  const { fonts, mark } = assets();
  return satori(
    buildCard(spec, mark) as unknown as Parameters<typeof satori>[0],
    { width: CARD.width, height: CARD.height, fonts },
  );
}

export async function renderCard(spec: CardSpec): Promise<Buffer> {
  const { mark, fingerprint } = assets();
  // The element tree carries the text, sizes and colours; the fingerprint
  // carries the fonts, the mark and the drawing pipeline.
  const key = createHash("sha256")
    .update(fingerprint)
    .update(JSON.stringify(buildCard(spec, mark)).replace(mark, "MARK"))
    .digest("hex");
  const cached = join(CACHE_DIR, `${key}.png`);
  if (existsSync(cached)) {
    stats.cached += 1;
    return readFileSync(cached);
  }
  const svg = await drawSvg(spec);
  // No alpha, palette-quantised: the card is flat colour, so this is a small
  // file (link previews are fetched by scrapers with size limits).
  const png = await sharp(Buffer.from(svg))
    .flatten({ background: GROUND })
    .png({ palette: true, compressionLevel: 9, effort: 7 })
    .toBuffer();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cached, png);
  stats.drawn += 1;
  return png;
}
