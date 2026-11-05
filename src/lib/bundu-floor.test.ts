import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Bundu floor (Mzizi registry 4.23.0 and 4.24.0; owner rulings of 1 to 4
 * November 2026; https://docs.mzizi.dev/foundations/bundu-floor and
 * /foundations/spacing-floor; issue #479): a 49px hit region on every control,
 * 14px between text and its container edge (the inline axis for a control),
 * 7px between adjacent controls, and a 3:1 contrast for a UI part. This guard
 * holds the bottom bar, the map's controls and the hero's icon group to it
 * (stage 1 of #479) and every font size in the app to the 14px text floor
 * (stage 2); the rest of the app follows in the stages that issue lists.
 */
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const css = read("app/globals.css");
const bottomNav = read("components/ui/mzizi-bottom-nav.tsx");
const map = read("app/[location]/map/MapDashboard.tsx");

/** The declaration of a custom property in :root, as written. */
const token = (name: string) =>
  css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

/** The rule body for a selector at the start of a line (any indentation). */
const rule = (selector: string) => {
  const at = css.search(
    new RegExp(
      `^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`,
      "m",
    ),
  );
  expect(at, `no ${selector} rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

const px = (value: string | undefined) => {
  const m = value?.match(/^([\d.]+)(px|rem)$/);
  if (!m) throw new Error(`not a length: ${value}`);
  return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
};

const channel = (n: number) => {
  const c = n / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
};
const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** `fg` at `alpha` over `bg`, as a luminance. */
const over = (fg: string, bg: string, alpha: number) => {
  const mix = (shift: number) =>
    Math.round(
      alpha * ((parseInt(fg.slice(1), 16) >> shift) & 255) +
        (1 - alpha) * ((parseInt(bg.slice(1), 16) >> shift) & 255),
    );
  return luminance(
    `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`,
  );
};

describe("the Bundu floor, as the registry names it", () => {
  it("is defined once, with the registry's numbers", () => {
    expect(css.match(/--target-floor:/g)).toHaveLength(1);
    expect(token("--target-floor")).toBe("49px");
    expect(token("--inset-floor")).toBe("14px");
    expect(token("--gap-floor")).toBe("7px");
    expect(token("--leading-floor")).toBe("1.5");
  });

  it("is the hit region of every control: --touch-target-min reads the floor", () => {
    expect(token("--touch-target-min")).toBe("var(--target-floor)");
    for (const selector of [".duiker", ".duiker-solid", ".bee"]) {
      const body = rule(selector);
      expect(body, selector).toContain("w-[var(--touch-target-min)]");
      expect(body, selector).toContain("h-[var(--touch-target-min)]");
    }
    expect(rule(".lark")).toContain("min-h-[var(--touch-target-min)]");
    // A pinned item and a chip are at least the floor wide as well as tall.
    expect(bottomNav).toContain("min-h-[var(--touch-target-min)]");
    expect(bottomNav).toContain("min-w-[var(--touch-target-min)]");
  });
});

describe("the float grid is above the floor, never under it", () => {
  it("keeps the inset over 14px and the gap over 7px", () => {
    expect(px(token("--float-inset"))).toBeGreaterThanOrEqual(
      px(token("--inset-floor")),
    );
    expect(px(token("--float-gap"))).toBeGreaterThanOrEqual(
      px(token("--gap-floor")),
    );
  });
});

describe("text in a control keeps the inline inset", () => {
  it("gives a chip and a pinned item the 14px inset, not a number of their own", () => {
    expect(rule(".lark")).toContain("px-[var(--inset-floor)]");
    const link = bottomNav.match(/"(plover [^"]*)",\s*hasLane/);
    expect(link).not.toBeNull();
    expect(bottomNav).toContain("shrink-0 px-[var(--inset-floor)]");
    // No 8px or 12px padding left on a target in the bar.
    for (const source of [link?.[1] ?? "", rule(".lark")]) {
      expect(source).not.toMatch(/(^|\s)px-(2|3)(\s|$)/);
    }
    // The chip's thicker active border still comes out of the same inset.
    expect(css.replace(/\s+/g, " ")).toContain(
      "padding-inline: calc( var(--inset-floor) - (var(--border-width-active) - var(--border-width-rest)) / 2 );",
    );
  });
});

describe("every floating surface has a visible edge", () => {
  it("defines the edge once and uses it on the bar, its targets, the hero group and the map's controls", () => {
    expect(css.match(/--float-border:/g)).toHaveLength(1);
    expect(token("--float-border")).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    );
    expect(bottomNav).toContain("border-[color:var(--float-border)]");
    expect(rule(".plover")).toContain("border-color: var(--float-border)");
    expect(rule(".lark")).toContain("border-[color:var(--float-border)]");
    expect(rule(".hadeda")).toContain(
      "border: var(--border-width-rest) solid var(--float-border)",
    );
    expect(rule(".serval")).toContain("ring-[color:var(--float-border)]");
    // The hairline between the map's two controls is the same edge.
    expect(map).toContain("bg-[color:var(--float-border)]");
  });

  it("is 3:1 or better against the surfaces it sits on, in both themes", () => {
    const [lightFg, darkFg] = css.match(/--foreground:\s*#[0-9a-f]{6}/g) ?? [];
    expect(lightFg && darkFg).toBeTruthy();
    const light = lightFg!.slice(-7);
    const dark = darkFg!.slice(-7);
    // The card (the bar's surface), the page, and the muted fill of a target.
    const lightSurfaces = ["#ffffff", "#faf9f5", "#f3f2ee"];
    const darkSurfaces = ["#100f0e", "#1e1e1e"];
    for (const bg of lightSurfaces) {
      expect(
        contrast(over(light, bg, 0.5), luminance(bg)),
        `light on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
    }
    for (const bg of darkSurfaces) {
      expect(
        contrast(over(dark, bg, 0.5), luminance(bg)),
        `dark on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
    }
    // The old edge was not: --mzizi-border on a card, the reason this exists.
    expect(contrast(luminance("#e7e5e0"), luminance("#ffffff"))).toBeLessThan(
      1.5,
    );
  });
});

/* ---------------------------------------------------------------------------
 * The spacing floor on the surfaces stage 1 of #479 brought up to it: the
 * phone menu, the bottom bar and the map. `mzizi check` (@nyuchi/mzizi-cli
 * 0.8.0) is the tool that reads the whole app; this is the part of it that
 * runs here, on these files only, until the CI ratchet (stage 6) takes over.
 * ------------------------------------------------------------------------ */

const accountMenu = read("components/ui/app-account-menu.tsx");
const phoneMenu = read("components/layout/PhoneMenu.tsx");

/** `text` with every comment blanked, line structure kept. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:"'`])\/\/.*$/gm,
      (m, lead: string) => lead + " ".repeat(m.length - lead.length),
    );
}

/** A Tailwind utility under the Bundu spacing floor, as `mzizi check` reads it. */
const BELOW_FLOOR: Array<[string, RegExp]> = [
  [
    "padding under the 14px inset",
    /(?<![\w-])!?(?:p|px|pl|pr|ps|pe)-(?:px|0\.5|1|1\.5|2|2\.5|3)(?![\w.[-])/g,
  ],
  [
    "padding of zero",
    /(?<![\w-])!?(?:p|px|py|pt|pb|pl|pr|ps|pe)-0(?![\w.[-])/g,
  ],
  [
    "gap under 7px",
    /(?<![\w-])!?(?:gap|gap-x|gap-y|space-x|space-y)-(?:0|px|0\.5|1|1\.5)(?![\w.[-])/g,
  ],
  ["negative margin", /(?<![\w-])!?-m[trblxyse]?-[\w.[\]()-]+/g],
  ["line height under 1.5", /(?<![\w-])leading-(?:none|tight|snug)(?![\w-])/g],
];

/** Everything under the floor in a source, minus lines with a written reason. */
function belowFloor(source: string): string[] {
  const raw = source.split("\n");
  const code = withoutComments(source).split("\n");
  const reasoned = (i: number) => {
    const marker = /mzizi-spacing-exempt:\s*(.*)/;
    const reason = (line: string | undefined) =>
      /[A-Za-z]{3,}/.test(line?.match(marker)?.[1] ?? "");
    // The same line, or a comment on its own line directly above.
    return (
      reason(raw[i]) ||
      (/^[\s{}]*$/.test(code[i - 1] ?? "x") && reason(raw[i - 1]))
    );
  };
  const out: string[] = [];
  code.forEach((line, i) => {
    for (const [what, pattern] of BELOW_FLOOR) {
      for (const m of line.matchAll(pattern)) {
        if (!reasoned(i)) out.push(`line ${i + 1}: ${m[0]} (${what})`);
      }
    }
  });
  return out;
}

describe("the phone menu keeps the floor", () => {
  it("is 49px tall on every row, the default trigger included", () => {
    expect(accountMenu).toMatch(
      /ACCOUNT_MENU_ROW_CLASS =\s*"flex min-h-\[var\(--touch-target-min\)\]/,
    );
    expect(accountMenu).toMatch(
      /triggerClassName \?\?\s*"flex min-h-\[var\(--touch-target-min\)\]/,
    );
  });

  it("gives every row and the identity block the 14px inset by token, not a literal", () => {
    const code = withoutComments(accountMenu);
    expect(code).toMatch(
      /ACCOUNT_MENU_ROW_CLASS =\s*"[^"]*px-\[var\(--inset-floor\)\]/,
    );
    expect(code).toContain('"px-[var(--inset-floor)] py-2"');
    // The three group headings line up with the rows. (The note that used to
    // expand under Notifications is gone: the row opens the notifications
    // centre, which keeps its own floor, see notifications.test.ts.)
    expect(
      withoutComments(phoneMenu).match(/!?px-\[var\(--inset-floor\)\]/g),
    ).toHaveLength(3);
  });

  it("sets its secondary text at 14px, not the 12px caption token", () => {
    expect(withoutComments(accountMenu)).not.toContain("--text-caption");
    expect(withoutComments(accountMenu)).toContain("--text-body-sm");
  });

  it("holds no padding, gap or leading under the floor except where a reason is written", () => {
    expect(belowFloor(accountMenu)).toEqual([]);
    expect(belowFloor(phoneMenu)).toEqual([]);
  });
});

describe("the bottom bar and the map keep the floor", () => {
  const files = [
    "components/ui/mzizi-bottom-nav.tsx",
    "components/layout/MobileNav.tsx",
    "components/layout/PlaceLane.tsx",
    "app/[location]/map/MapDashboard.tsx",
    "components/weather/map/MapLibreMap.tsx",
    "components/weather/map/MapTimeline.tsx",
    "components/weather/map/MapSkeleton.tsx",
    "components/weather/map/MapPreview.tsx",
    "components/weather/map/WeatherLayerPanel.tsx",
  ];

  for (const file of files) {
    it(`${file} holds nothing under the floor without a written reason`, () => {
      expect(belowFloor(read(file))).toEqual([]);
    });
  }

  it("takes the gap between a pinned item's icon and label, a lane chip's glyph and label, and the timeline's controls from --gap-floor", () => {
    expect(bottomNav).toContain("gap-[var(--gap-floor)] rounded-full py-1");
    expect(rule(".lark")).toContain("gap-[var(--gap-floor)]");
    const timeline = read("components/weather/map/MapTimeline.tsx");
    expect(timeline.match(/gap-\[var\(--gap-floor\)\]/g)).toHaveLength(2);
  });

  it("gives the map's locate message the 14px inset on both sides", () => {
    expect(map).toContain(
      "max-w-[12rem] px-[var(--inset-floor)] py-2 text-sm text-text-secondary",
    );
  });

  it("explains each exemption in a comment with a reason, never a bare marker", () => {
    for (const file of files) {
      for (const line of read(file).split("\n")) {
        const at = line.indexOf("mzizi-spacing-exempt");
        if (at === -1) continue;
        expect(line.slice(at), `${file}: ${line.trim()}`).toMatch(
          /mzizi-spacing-exempt:\s*[^]*[A-Za-z]{3,}/,
        );
      }
    }
    // The two CSS exemptions (the range thumb's offset) live in globals.css.
    expect(css).toMatch(/mzizi-spacing-exempt:[^*]*centres the 24px thumb/);
  });
});

/* ---------------------------------------------------------------------------
 * The text floor (stage 2 of #479): nothing a person reads is set under 14px.
 *
 * Mzizi registry 4.23.0 raised the caption and the small size to 14px; the
 * Bundu floor is "captions, metadata and secondary text 14px, body 17px". This
 * stage is the 14px part (the 17px body is a later stage of #479). The scan
 * below reads every source and style sheet under src (not tests) for a font
 * size under the floor, and a size that cannot be read from source at all (SVG
 * text scales with its viewBox, so a 13px label drew at 9px in a phone-width
 * tile) is refused rather than guessed. Where a size is deliberately under
 * the floor, a comment says why: `mzizi-text-exempt: <reason>` on the line or
 * the comment line above it, or `mzizi-text-exempt-file: <reason>` for a file
 * that is not interface text (an image, a printed page). A bare marker excuses
 * nothing: the reason is required.
 * ------------------------------------------------------------------------ */

const TEXT_FLOOR_PX = 14;

/** Every .ts, .tsx and .css file under src that is not a test. */
function sourceFiles(dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__fixtures__") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (
      /\.(tsx?|css)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** A CSS length in px, or null when it is relative (em, %) and so unknowable. */
function lengthPx(value: string, unit: string): number | null {
  const n = Number(value);
  if (unit === "px" || unit === "") return n;
  if (unit === "rem") return n * 16;
  if (unit === "pt") return (n * 4) / 3;
  return null;
}

/** `--text-*` sizes declared in globals.css, in px (leadings are not sizes). */
const textTokens = new Map<string, number>();
for (const m of css.matchAll(/--text-([a-z0-9-]+):\s*([\d.]+)(rem|px);/g)) {
  if (m[1].endsWith("-leading") || m[1].includes("--")) continue;
  textTokens.set(m[1], Number(m[2]) * (m[3] === "rem" ? 16 : 1));
}

/** Font sizes under the floor in a source, minus lines with a written reason. */
function textBelowFloor(source: string): string[] {
  const fileReason = source.match(/mzizi-text-exempt-file:\s*([^\n]*)/)?.[1];
  if (/[A-Za-z]{3,}/.test(fileReason ?? "")) return [];
  const raw = source.split("\n");
  const code = withoutComments(source).split("\n");
  const reasoned = (i: number) => {
    const reason = (line: string | undefined) =>
      /[A-Za-z]{3,}/.test(line?.match(/mzizi-text-exempt:\s*(.*)/)?.[1] ?? "");
    return (
      reason(raw[i]) ||
      (/^[\s{}]*$/.test(code[i - 1] ?? "x") && reason(raw[i - 1]))
    );
  };
  const rules: Array<[string, RegExp, (m: RegExpMatchArray) => number | null]> =
    [
      [
        "a literal Tailwind size",
        /(?<![\w-])text-\[(?:length:)?([\d.]+)(px|rem|em|pt|%)\]/g,
        (m) => lengthPx(m[1], m[2]),
      ],
      [
        "a size token under the floor",
        /(?<![\w-])text-\[length:var\(--text-([a-z0-9-]+)\)\]/g,
        (m) => textTokens.get(m[1]) ?? null,
      ],
      [
        "a Tailwind size below xs",
        /(?<![\w-])text-([0-9])xs(?![\w-])/g,
        () => 0,
      ],
      [
        "a CSS font-size",
        /font-size:\s*([\d.]+)(px|rem|em|pt|%)/g,
        (m) => lengthPx(m[1], m[2]),
      ],
      [
        "a CSS font-size token under the floor",
        /font-size:\s*var\(--text-([a-z0-9-]+)\)/g,
        (m) => textTokens.get(m[1]) ?? null,
      ],
      [
        "a font shorthand",
        /(?<![\w-])font:\s*(?:[a-z0-9-]+\s+){0,3}([\d.]+)(px|rem|pt)\b/g,
        (m) => lengthPx(m[1], m[2]),
      ],
      [
        "an inline fontSize",
        /fontSize[=:]\s*\{?\s*(\d[\d.]*)/g,
        (m) => Number(m[1]),
      ],
      [
        "a canvas font size",
        /font:\s*\{\s*size:\s*(\d[\d.]*)/g,
        (m) => Number(m[1]),
      ],
      [
        "a map text-size",
        /["']text-size["']\s*:\s*(\d[\d.]*)/g,
        (m) => Number(m[1]),
      ],
    ];
  const out: string[] = [];
  code.forEach((line, i) => {
    for (const [what, pattern, size] of rules) {
      for (const m of line.matchAll(pattern)) {
        const px = size(m);
        // null is a relative size or an unknown token: not readable from
        // source, so not allowed either.
        if ((px === null || px < TEXT_FLOOR_PX) && !reasoned(i)) {
          out.push(`line ${i + 1}: ${m[0]} (${what})`);
        }
      }
    }
    // SVG text is sized in the viewBox's units and scales with the element.
    if (/<(?:text|tspan)[\s>]/.test(line) && !reasoned(i)) {
      out.push(`line ${i + 1}: SVG <text> (it scales with its viewBox)`);
    }
  });
  return out;
}

describe("the Tailwind text sizes and the size tokens are at the floor", () => {
  it("raises --text-caption to the registry's 14px at 1.5 leading", () => {
    expect(token("--text-caption")).toBe("0.875rem");
    expect(token("--text-caption-leading")).toBe("1.5");
  });

  it("raises text-xs and text-sm to the floor the way the registry does", () => {
    const theme = css.slice(css.indexOf("@theme inline {"));
    expect(theme).toContain("--text-xs: var(--text-caption);");
    expect(theme).toContain(
      "--text-xs--line-height: var(--text-caption-leading);",
    );
    expect(theme).toContain("--text-sm: 0.875rem;");
    expect(theme).toContain("--text-sm--line-height: 1.5;");
  });

  it("declares no size token under 14px", () => {
    expect(textTokens.size).toBeGreaterThan(10);
    for (const [name, px] of textTokens) {
      expect(px, `--text-${name}`).toBeGreaterThanOrEqual(TEXT_FLOOR_PX);
    }
  });

  it("draws chart text, tooltips and axes at the floor", () => {
    const chart = read("components/ui/chart.tsx");
    const px = Number(chart.match(/export const CHART_FONT_PX = (\d+);/)?.[1]);
    expect(px).toBeGreaterThanOrEqual(TEXT_FLOOR_PX);
    expect(chart).toContain("ChartJS.defaults.font.size = CHART_FONT_PX;");
    const series = read("components/weather/charts/TimeSeriesChart.tsx");
    expect(series.match(/font: \{ size: CHART_FONT_PX \}/g)).toHaveLength(3);
  });

  it("lifts the credits MapLibre's own stylesheet sets at 12px to the caption token", () => {
    expect(css).toMatch(
      /\.maplibregl-map \.maplibregl-ctrl-attrib,[\s\S]*?\{\s*font-size: var\(--text-caption\);/,
    );
  });
});

describe("no source under src sets text under the 14px floor", () => {
  const files = sourceFiles();

  it("reads the whole app, not a handful of files", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("holds nothing under the floor without a written reason", () => {
    const found: string[] = [];
    for (const file of files) {
      for (const hit of textBelowFloor(readFileSync(file, "utf8"))) {
        found.push(`${file.slice(root.length + 1)} ${hit}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("exempts only the two files that are not interface text", () => {
    const exempt = files
      .filter((f) => /mzizi-text-exempt-file:/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1))
      .sort();
    expect(exempt).toEqual([
      "app/api/og/route.tsx",
      "app/aviation/AviationBriefingPDF.tsx",
    ]);
  });

  it("explains every exemption with a reason, never a bare marker", () => {
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const at = line.search(/mzizi-text-exempt(?:-file)?:/);
        if (at === -1 || /\bmzizi-text-exempt-file:\s*$/.test(line)) continue;
        expect(line.slice(at), `${file}: ${line.trim()}`).toMatch(
          /mzizi-text-exempt(?:-file)?:\s*[^]*[A-Za-z]{3,}/,
        );
      }
    }
  });
});

describe("the text scan itself (a violation is found; a reason excuses it)", () => {
  it("finds a literal size, an under-floor token, a CSS size, a canvas size and SVG text", () => {
    expect(textBelowFloor('<p className="text-[11px]">x</p>')).toHaveLength(1);
    expect(textBelowFloor('<p className="text-[0.75rem]">x</p>')).toHaveLength(
      1,
    );
    expect(
      textBelowFloor('<p className="text-[length:0.8em]">x</p>'),
    ).toHaveLength(1);
    expect(textBelowFloor('<p className="text-2xs">x</p>')).toHaveLength(1);
    expect(textBelowFloor(".a { font-size: 13px; }")).toHaveLength(1);
    expect(textBelowFloor(".a { font: 12px/20px Arial; }")).toHaveLength(1);
    expect(textBelowFloor("const o = { fontSize: 10 };")).toHaveLength(1);
    expect(textBelowFloor("ticks: { font: { size: 11 } }")).toHaveLength(1);
    expect(textBelowFloor('{ "text-size": 12 }')).toHaveLength(1);
    expect(textBelowFloor('<svg><text x="1">1</text></svg>')).toHaveLength(1);
  });

  it("finds a token that is under the floor and one that does not exist", () => {
    expect(textTokens.get("caption")).toBe(14);
    expect(
      textBelowFloor('<p className="text-[length:var(--text-nope)]">x</p>'),
    ).toHaveLength(1);
  });

  it("lets the floor and everything above it through", () => {
    for (const ok of [
      '<p className="text-sm text-xs text-base">x</p>',
      '<p className="text-[14px] text-[0.875rem] text-[length:var(--text-caption)]">x</p>',
      '<p className="text-[length:var(--text-nav-label)] text-[color:var(--x)]">x</p>',
      ".a { font-size: 14px; } .b { font-size: var(--text-body-sm); }",
      "ticks: { font: { size: CHART_FONT_PX } }",
    ]) {
      expect(textBelowFloor(ok), ok).toEqual([]);
    }
  });

  it("is excused by a written reason on the line or the line above, and by nothing less", () => {
    const line = '<p className="text-[11px]">x</p>';
    expect(
      textBelowFloor(`${line} // mzizi-text-exempt: a printed legend`),
    ).toEqual([]);
    expect(
      textBelowFloor(`// mzizi-text-exempt: a printed legend\n${line}`),
    ).toEqual([]);
    expect(
      textBelowFloor(`/* mzizi-text-exempt: an image */\n${line}`),
    ).toEqual([]);
    expect(textBelowFloor(`// mzizi-text-exempt:\n${line}`)).toHaveLength(1);
    expect(textBelowFloor(`// mzizi-text-exempt: x\n${line}`)).toHaveLength(1);
    expect(
      textBelowFloor(`// mzizi-text-exempt: a reason\n\n${line}`),
    ).toHaveLength(1);
    expect(
      textBelowFloor(`// mzizi-text-exempt-file: a printed page\n${line}`),
    ).toEqual([]);
  });

  it("ignores a size named in a comment", () => {
    expect(textBelowFloor("// was text-[11px] before\nconst a = 1;")).toEqual(
      [],
    );
    expect(textBelowFloor("/* font-size: 12px */")).toEqual([]);
  });
});
