import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCATIONS } from "@/lib/locations";
import { buildCard, fitCard, latticeSvg } from "./card";
import { allCards, locationCard, pageCards, siteCard } from "./cards";
import { DOMAIN, GROUND, MINERALS, SECONDARY, TITLE, apca } from "./colors";
import { PAGE_CARDS, ogPathFor, ogUrlFor, pageSlug } from "./pages";
import { drawSvg, renderCard } from "./render";
import {
  clean,
  fitTitle,
  graphemes,
  isRenderable,
  nameFromSlug,
  truncate,
} from "./text";

const here = fileURLToPath(new URL(".", import.meta.url));
const astroRoot = join(here, "../../..");
const read = (path: string) => readFileSync(join(astroRoot, path), "utf8");

describe("colours (APCA on the ground, Mzizi floors: Lc 75 large, Lc 90 body)", () => {
  it("clears the floors for every text role", () => {
    expect(apca(TITLE, GROUND)).toBeGreaterThanOrEqual(90);
    expect(apca(SECONDARY, GROUND)).toBeGreaterThanOrEqual(75);
    expect(apca(DOMAIN, GROUND)).toBeGreaterThanOrEqual(75);
  });

  it("is at least what the skill's table states (92, 81, 76)", () => {
    // The skill's figures come from another APCA revision; this one
    // (0.0.98G-4g) reads the same colours higher, so the table is a floor.
    expect(apca(TITLE, GROUND)).toBeGreaterThanOrEqual(92);
    expect(apca(SECONDARY, GROUND)).toBeGreaterThanOrEqual(81);
    expect(apca(DOMAIN, GROUND)).toBeGreaterThanOrEqual(76);
  });

  it("calls a dim grey too dim, as the skill warns", () => {
    expect(apca("#B2AFA8", GROUND)).toBeLessThan(75);
  });
});

describe("text fitting", () => {
  it("cuts long text with an ellipsis and leaves short text alone", () => {
    expect(truncate("Harare", 20)).toBe("Harare");
    const cut = truncate(
      "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch",
      12,
    );
    expect(graphemes(cut)).toHaveLength(12);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("counts characters people see, not code units", () => {
    // "e" + combining acute, and a family emoji (ZWJ sequence), are one each.
    const text = "Café 👨‍👩‍👧 Zürich";
    expect(graphemes(text)).toHaveLength(13);
    const cut = truncate(text, 6);
    // the accent stays on its letter; the cut trims the space before the ellipsis
    expect(graphemes(cut)).toHaveLength(5);
    expect(cut).toBe("Cafe\u0301…");
  });

  it("keeps non-ASCII names whole", () => {
    expect(truncate("São Tomé and Príncipe", 40)).toBe("São Tomé and Príncipe");
    expect(truncate("Nguyễn Thị Minh Khai", 8)).toBe("Nguyễn…");
  });

  it("strips control and bidi-override characters and collapses space", () => {
    expect(
      clean("  a\u0000b " + String.fromCharCode(0x202e) + " c\n\td "),
    ).toBe("a b c d");
  });

  it("picks a smaller size for a longer title, and never below the floor", () => {
    const short = fitTitle("Harare", 800);
    const long = fitTitle(
      "Saint Petersburg and the Islands of the Gulf of Finland",
      800,
    );
    expect(short.size).toBeGreaterThan(long.size);
    const absurd = fitTitle("x".repeat(500), 800);
    expect(absurd.size).toBe(48);
    expect(graphemes(absurd.text).length).toBeLessThan(500);
    expect(absurd.text.endsWith("…")).toBe(true);
  });

  it("handles a title that is one unbreakable word", () => {
    const fit = fitTitle(
      "Taumatawhakatangihangakoauauotamateaturipukakapikimaungahoronukupokaiwhenuakitanatahu",
      800,
    );
    expect(fit.size).toBeLessThanOrEqual(56);
  });

  it("falls back to the site name for an empty title", () => {
    expect(fitTitle("   ", 800).text).toBe("mukoko weather");
  });

  it("knows which scripts the bundled fonts draw", () => {
    expect(isRenderable("Zürich")).toBe(true);
    expect(isRenderable("Hà Nội")).toBe(true);
    expect(isRenderable("São Tomé")).toBe(true);
    expect(isRenderable("القاهرة")).toBe(false);
    expect(isRenderable("東京")).toBe(false);
    expect(nameFromSlug("port-elizabeth-za")).toBe("Port Elizabeth");
  });
});

const HOSTILE = `<script>alert(1)</script> & "quoted" 'single' </text><image href="x"/>`;

/** Every element and attribute value in a satori tree. */
function walk(
  node: unknown,
  visit: (n: { type: string; props: Record<string, unknown> }) => void,
) {
  if (!node || typeof node !== "object") return;
  const n = node as { type: string; props: Record<string, unknown> };
  visit(n);
  const kids = n.props.children;
  for (const k of Array.isArray(kids) ? kids : [kids]) walk(k, visit);
}

describe("the card builder does not inject markup", () => {
  const tree = buildCard(
    { eyebrow: HOSTILE, title: HOSTILE, description: HOSTILE, domain: HOSTILE },
    "data:image/svg+xml;base64,AAAA",
  );

  it("passes hostile text through as plain string children", () => {
    const strings: string[] = [];
    walk(tree, (n) => {
      if (typeof n.props.children === "string") strings.push(n.props.children);
      for (const key of Object.keys(n.props)) {
        expect(key).not.toMatch(/innerhtml|dangerously/i);
      }
    });
    // the text is there as text (cut to fit), including the angle bracket
    expect(strings.some((s) => s.includes("<script>"))).toBe(true);
  });

  it("only ever names the fixed element types", () => {
    const types = new Set<string>();
    walk(tree, (n) => types.add(n.type));
    expect([...types].sort()).toEqual(["div", "img"]);
  });

  it("draws hostile text as glyphs, not as markup", async () => {
    const svg = await drawSvg({
      eyebrow: HOSTILE,
      title: HOSTILE,
      description: HOSTILE,
      domain: HOSTILE,
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/alert\(1\)/);
    expect(svg).not.toMatch(/href="x"/);
    const tags = new Set(
      [...svg.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]),
    );
    for (const tag of tags) {
      expect([
        "svg",
        "defs",
        "clipPath",
        "path",
        "rect",
        "image",
        "g",
        "mask",
        "pattern",
        "text",
        "tspan",
      ]).toContain(tag);
    }
  });

  it("builds the lattice from numbers and fixed colours only", () => {
    const svg = latticeSvg();
    expect(svg).not.toMatch(/<script|onload|href/i);
    for (const hex of Object.values(MINERALS)) expect(svg).toContain(hex);
  });
});

describe("fitCard", () => {
  it("clamps every field", () => {
    const fit = fitCard({
      eyebrow: "e".repeat(300),
      title: "t".repeat(300),
      description: "d".repeat(900),
      domain: "x".repeat(300),
    });
    expect(graphemes(fit.eyebrow).length).toBeLessThanOrEqual(36);
    expect(graphemes(fit.description).length).toBeLessThanOrEqual(170);
    expect(graphemes(fit.domain).length).toBeLessThanOrEqual(60);
  });
});

describe("the mark is the file, unchanged", () => {
  const svg = readFileSync(join(astroRoot, "../public/logo-dark.svg"), "utf8");

  it("is the Seed of Life: seven flat cells in the seven dark minerals", () => {
    const fills = [...svg.matchAll(/<polygon[^>]*fill="(#[0-9A-F]{6})"/gi)].map(
      (m) => m[1].toUpperCase(),
    );
    expect(fills).toHaveLength(7);
    expect(new Set(fills)).toEqual(
      new Set([
        "#00B0FF",
        "#FFD740",
        "#64FFDA",
        "#FF8A65",
        "#3D5AFE",
        "#E1B07E",
        "#B388FF",
      ]),
    );
    expect(svg).not.toMatch(/gradient|filter|opacity/i);
  });

  it("is embedded byte for byte in the card", async () => {
    const out = await drawSvg({
      title: "Harare",
      domain: "weather.mukoko.com",
    });
    // satori inlines an <img> SVG as an <image> with the same data: URI
    const b64 = Buffer.from(svg).toString("base64");
    expect(out).toContain(b64);
  });
});

describe("the cards", () => {
  const cards = allCards();

  it("has one card per shipped place, with the place's own slug", () => {
    const slugs = cards.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const loc of LOCATIONS) {
      expect(slugs).toContain(`locations/${loc.slug}`);
      expect(loc.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    expect(slugs.filter((s) => s.startsWith("locations/"))).toHaveLength(
      LOCATIONS.length,
    );
  });

  it("names place, country and region, and the page's own domain line", () => {
    const loc = LOCATIONS.find(
      (l) => l.province !== l.name && l.country === "ZW",
    )!;
    const card = locationCard(loc);
    expect(card.spec.title).toBe(loc.name);
    expect(card.spec.eyebrow).toContain("Zimbabwe");
    expect(card.spec.eyebrow).toContain(loc.province);
    expect(card.spec.domain).toBe(`weather.mukoko.com/${loc.slug}`);
    expect(card.spec.description).toContain(loc.name);
  });

  it("falls back to the slug for a name the fonts cannot draw, keeps accents", () => {
    const base = LOCATIONS[0];
    const arabic = locationCard({
      ...base,
      slug: "al-qahira-eg",
      name: "القاهرة",
    });
    expect(arabic.spec.title).toBe("Al Qahira");
    const accented = locationCard({
      ...base,
      slug: "zurich-ch",
      name: "Zürich",
    });
    expect(accented.spec.title).toBe("Zürich");
  });

  it("has the site card and a card for each page", () => {
    expect(siteCard().slug).toBe("site");
    expect(pageCards().map((c) => c.slug)).toEqual(
      PAGE_CARDS.map((p) => pageSlug(p.path)),
    );
  });
});

describe("page cards say what the page says", () => {
  const flat = (t: string) => t.replace(/\s+/g, " ");
  const prop = (source: string, name: string) =>
    flat(source)
      .match(new RegExp(`${name}="([^"]*)"`))?.[1]
      ?.replaceAll("&amp;", "&");

  for (const page of PAGE_CARDS) {
    it(`${page.path}: title, description and canonical path match src/pages/${page.file}`, () => {
      const source = read(`src/pages/${page.file}`);
      expect(prop(source, "title")).toBe(page.title);
      expect(prop(source, "description")).toBe(page.description);
      expect(prop(source, "canonicalPath")).toBe(page.path);
    });
  }

  it("covers every page that has a canonical path", () => {
    const files = readdirSync(join(astroRoot, "src/pages")).filter((f) =>
      f.endsWith(".astro"),
    );
    const withCanonical = files.filter((f) =>
      /canonicalPath="/.test(read(`src/pages/${f}`)),
    );
    expect(withCanonical.sort()).toEqual(PAGE_CARDS.map((p) => p.file).sort());
  });
});

describe("the head never hardcodes an image", () => {
  it("derives og:image and twitter:image from the shell, as absolute URLs", () => {
    const shell = read("src/layouts/Shell.astro");
    expect(shell).toContain('<meta property="og:image" content={cardUrl} />');
    expect(shell).toContain('<meta name="twitter:image" content={cardUrl} />');
    expect(shell).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
    expect(shell).toContain("new URL(ogImage, Astro.site).href");
  });

  it("has no literal og:image, twitter:image or /api/og anywhere else in the app", () => {
    const stack = [join(astroRoot, "src")];
    const offenders: string[] = [];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (
          /\.(astro|tsx?|mjs)$/.test(entry.name) &&
          !/\.test\./.test(entry.name)
        ) {
          const text = readFileSync(path, "utf8");
          if (path.endsWith("layouts/Shell.astro")) continue;
          if (
            /og:image|twitter:image|\/api\/og/.test(
              text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
            )
          )
            offenders.push(path);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("points a page at its own card and anything else at the site card, absolutely", () => {
    expect(ogPathFor("/terms")).toBe("/og/pages/terms.png");
    expect(ogPathFor("/no-such-page")).toBe("/og/site.png");
    expect(ogPathFor(undefined)).toBe("/og/site.png");
    expect(ogUrlFor("/terms")).toBe(
      "https://weather.mukoko.com/og/pages/terms.png",
    );
    expect(ogUrlFor()).toMatch(/^https:\/\//);
  });
});

describe("rendering", () => {
  it("draws a 1200x630 PNG for hard cases (and writes them when OG_DEBUG_DIR is set)", async () => {
    const hard = {
      long: locationCard({
        ...LOCATIONS[0],
        slug: "very-long",
        name: "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch and the Surrounding Valleys",
        province: "Gwynedd and Anglesey Combined Authority Region",
      }),
      accented: locationCard({
        ...LOCATIONS[0],
        slug: "sao-tome-st",
        name: "São Tomé",
        province: "Água Grande",
        country: "ST",
      }),
      vietnamese: locationCard({
        ...LOCATIONS[0],
        slug: "hanoi-vn",
        name: "Nguyễn Thị Minh Khai Ward, Hà Nội",
        province: "Hà Nội",
        country: "VN",
      }),
      hostile: {
        slug: "hostile",
        alt: "",
        spec: {
          eyebrow: "Test",
          title: HOSTILE,
          description: HOSTILE,
          domain: "weather.mukoko.com",
        },
      },
    };
    const dir = process.env.OG_DEBUG_DIR;
    for (const [name, card] of Object.entries(hard)) {
      const png = await renderCard(card.spec);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(630);
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.png`), png);
      }
    }
  }, 60_000);
});
