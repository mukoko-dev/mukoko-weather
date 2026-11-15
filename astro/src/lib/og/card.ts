/**
 * The hive card: the Mzizi OG template (mzizi:discoverability) as a satori
 * element tree. Pure and build-agnostic: no fonts, no files and no markup
 * strings. Every piece of text is a child of an element object, never HTML
 * that something parses, so a place called `<script>` or `&amp;` is drawn as
 * those characters. (The only SVG built as a string is the lattice, from
 * numbers and fixed colours.)
 */
import { DOMAIN, GROUND, MINERALS, SECONDARY, TITLE } from "./colors";
import { fitTitle, truncate } from "./text";

/** Font stacks: the Latin subset, then the ones that cover accents (see render.ts). */
export const SANS = "Noto Sans, Noto Sans latin-ext, Noto Sans vietnamese";
export const SERIF = "Noto Serif, Noto Serif latin-ext, Noto Serif vietnamese";

export const CARD = { width: 1200, height: 630 } as const;

export interface CardSpec {
  /** Small line above the title (place's country and region, or the site name). */
  eyebrow?: string;
  title: string;
  description?: string;
  /** The line at the bottom: host and path, no scheme. */
  domain: string;
}

/** Pixels from the left edge to the text column, and the column's width. */
const PAD = 72;
const COLUMN = 800;

const R = 48; // hexagon circumradius
const DX = R * 1.5;
const DY = Math.sqrt(3) * R;

function hexagon(cx: number, cy: number, r: number): string {
  const points = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (Math.PI / 3) * i; // flat-top: a vertex at 0 degrees
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  });
  return points.join(" ");
}

/** [column, row, mineral]: a few solid cells, on the right, away from the text. */
const ACCENTS: readonly [number, number, keyof typeof MINERALS][] = [
  [14, 1, "cobalt"],
  [15, 2, "gold"],
  [13, 6, "tanzanite"],
  [16, 6, "malachite"],
  [15, 7, "copper"],
];

/** The faint flat-top honeycomb (white at 5%) with the accent cells. */
export function latticeSvg(): string {
  const cells: string[] = [];
  for (let c = -1; c <= 17; c++) {
    for (let r = -1; r <= 8; r++) {
      const cx = c * DX;
      const cy = r * DY + (c % 2 ? DY / 2 : 0);
      cells.push(
        `<polygon points="${hexagon(cx, cy, R)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.05" stroke-width="2"/>`,
      );
    }
  }
  for (const [c, r, mineral] of ACCENTS) {
    const cx = c * DX;
    const cy = r * DY + (c % 2 ? DY / 2 : 0);
    cells.push(
      `<polygon points="${hexagon(cx, cy, R - 4)}" fill="${MINERALS[mineral]}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" viewBox="0 0 ${CARD.width} ${CARD.height}">${cells.join("")}</svg>`;
}

type Node = { type: string; props: Record<string, unknown> };
const el = (
  type: string,
  props: Record<string, unknown>,
  children?: unknown,
): Node => ({
  type,
  props: children === undefined ? props : { ...props, children },
});

/** The text of a card after fitting: what the tests and the renderer both see. */
export function fitCard(spec: CardSpec) {
  const title = fitTitle(spec.title, COLUMN);
  const eyebrow = spec.eyebrow ? truncate(spec.eyebrow, 36) : "";
  const description = spec.description ? truncate(spec.description, 170) : "";
  const domain = truncate(spec.domain, 60);
  return { title, eyebrow, description, domain };
}

/**
 * @param markDataUri the Seed of Life mark file, unchanged, as a data: URI
 */
export function buildCard(spec: CardSpec, markDataUri: string): Node {
  const { title, eyebrow, description, domain } = fitCard(spec);
  const sans = SANS;
  return el(
    "div",
    {
      style: {
        width: CARD.width,
        height: CARD.height,
        display: "flex",
        position: "relative",
        backgroundColor: GROUND,
      },
    },
    [
      el("img", {
        src: `data:image/svg+xml;base64,${Buffer.from(latticeSvg()).toString("base64")}`,
        width: CARD.width,
        height: CARD.height,
        style: { position: "absolute", top: 0, left: 0 },
      }),
      el(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            width: COLUMN,
            height: CARD.height,
            boxSizing: "border-box",
            padding: `56px ${PAD}px 52px`,
          },
        },
        [
          el("img", {
            src: markDataUri,
            width: 88,
            height: 88,
            style: { width: 88, height: 88, marginBottom: 28 },
          }),
          eyebrow
            ? el(
                "div",
                {
                  style: {
                    fontFamily: sans,
                    fontWeight: 600,
                    fontSize: 26,
                    letterSpacing: 2.5,
                    color: SECONDARY,
                    marginBottom: 14,
                    lineClamp: 1,
                  },
                },
                eyebrow.toLocaleUpperCase("en"),
              )
            : null,
          el(
            "div",
            {
              style: {
                fontFamily: SERIF,
                fontWeight: 700,
                fontSize: title.size,
                lineHeight: 1.1,
                color: TITLE,
                wordBreak: "break-word",
                lineClamp: title.maxLines,
              },
            },
            title.text,
          ),
          description
            ? el(
                "div",
                {
                  style: {
                    fontFamily: sans,
                    fontWeight: 400,
                    fontSize: 30,
                    lineHeight: 1.35,
                    color: SECONDARY,
                    marginTop: 22,
                    lineClamp: 2,
                    wordBreak: "break-word",
                  },
                },
                description,
              )
            : null,
          // satori has no `margin-top: auto`: a growing spacer does the job.
          el("div", { style: { display: "flex", flexGrow: 1 } }),
          el(
            "div",
            {
              style: {
                fontFamily: sans,
                fontWeight: 600,
                fontSize: 30,
                color: DOMAIN,
              },
            },
            domain,
          ),
        ].filter(Boolean),
      ),
    ],
  );
}
