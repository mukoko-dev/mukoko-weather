import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const APP = path.resolve(__dirname);
const globals = readFileSync(path.join(APP, "globals.css"), "utf8");
const canon = readFileSync(path.join(APP, "mzizi-tokens.css"), "utf8");

const MINERALS = [
  "cobalt",
  "tanzanite",
  "malachite",
  "gold",
  "terracotta",
  "sodalite",
  "copper",
] as const;

/** Value of a declaration in a stylesheet (first match), or undefined. */
function declValue(css: string, name: string): string | undefined {
  const m = css.match(new RegExp(`(?:^|[\\s;{])${name}:\\s*([^;]+);`, "m"));
  return m?.[1].trim();
}

describe("Mzizi token adoption", () => {
  describe("import order", () => {
    it("imports mzizi-tokens.css as the first statement in globals.css", () => {
      const firstImport = globals.match(/^@import\s+[^;]+;/m)?.[0];
      expect(firstImport).toBe('@import "./mzizi-tokens.css";');
    });

    it("places the mzizi import before the app's own :root block", () => {
      expect(globals.indexOf("mzizi-tokens.css")).toBeLessThan(
        globals.indexOf(":root {"),
      );
    });
  });

  describe("canonical stylesheet", () => {
    it("defines all seven minerals in light and dark", () => {
      for (const m of MINERALS) {
        expect(canon).toContain(`--color-${m}: #`);
        expect(canon).toContain(`--color-${m}-container: #`);
        expect(canon).toContain(`--color-${m}-on-container: #`);
      }
      // Dark values are applied under the class and the app's data-theme attribute.
      expect(canon).toMatch(/\.dark,\s*\[data-theme="dark"\]\s*\{/);
    });

    it("keeps the Mzizi radius scale", () => {
      expect(declValue(canon, "--radius-sm")).toBe("7px");
      expect(declValue(canon, "--radius-md")).toBe("12px");
      expect(declValue(canon, "--radius-lg")).toBe("14px");
      expect(declValue(canon, "--radius-xl")).toBe("17px");
      expect(declValue(canon, "--radius-full")).toBe("9999px");
    });

    it("scopes the OS-preference fallback so an explicit theme wins", () => {
      expect(canon).toContain(
        ':root:not([data-theme="light"]):not(.light)',
      );
    });
  });

  describe("mineral tokens resolve to Mzizi variables, not hex", () => {
    it("aliases every app mineral token to --color-<mineral>", () => {
      for (const m of MINERALS) {
        expect(globals).toMatch(
          new RegExp(`--color-mineral-${m}-raw:\\s*var\\(--color-${m}\\);`),
        );
        expect(globals).toMatch(
          new RegExp(`--mineral-${m}:\\s*var\\(--color-${m}\\);`),
        );
        expect(globals).toMatch(
          new RegExp(`--container-${m}:\\s*var\\(--color-${m}-container\\);`),
        );
        expect(globals).toMatch(
          new RegExp(
            `--on-container-${m}:\\s*var\\(--color-${m}-on-container\\);`,
          ),
        );
      }
    });

    it("contains no hex literal on a mineral-named token (foregrounds excepted)", () => {
      const offenders = globals
        .split("\n")
        .filter((l) =>
          new RegExp(
            `--(color-mineral-|mineral-|container-|on-container-)(${MINERALS.join("|")})(-raw)?:\\s*#`,
          ).test(l),
        );
      expect(offenders).toEqual([]);
    });

    it("keeps the app-only mineral foregrounds as explicit colours", () => {
      expect(globals).toMatch(/--mineral-cobalt-fg:\s*#ffffff;/);
      expect(globals).toMatch(/--mineral-cobalt-fg:\s*#0a0a0a;/);
    });

    it("points primary, ring and focus at the Mzizi storm experimental family", () => {
      for (const token of ["--color-primary", "--primary", "--ring", "--focus-ring"]) {
        expect(globals).toMatch(new RegExp(`${token}:\\s*var\\(--exp-storm\\);`));
      }
      expect(canon).toMatch(/--exp-storm:\s*#284ca6;/);
      expect(canon).toMatch(/\.dark,\s*\[data-theme="dark"\][\s\S]*?--exp-storm:\s*#7e9be0;/);
    });

    it("keeps cobalt as the travel-category mineral", () => {
      expect(globals).toMatch(/--mineral-cobalt:\s*var\(--color-cobalt\);/);
    });
  });

  describe("drift fixes", () => {
    it("uses Mzizi radii for cards, inputs and the Tailwind scale", () => {
      expect(globals).toMatch(/--radius-card:\s*var\(--radius-lg\);/);
      expect(globals).toMatch(/--radius-input:\s*var\(--radius-md\);/);
      expect(globals).toMatch(/--radius-sm:\s*7px;/);
      expect(globals).toMatch(/--radius-md:\s*12px;/);
      expect(globals).toMatch(/--radius-xl:\s*17px;/);
      expect(globals).toMatch(/--radius:\s*var\(--radius-lg\)/);
      // Buttons and badges stay pill-shaped.
      expect(globals).toMatch(/--radius-button:\s*9999px;/);
    });

    it("uses the Mzizi border and destructive values in both themes", () => {
      expect(canon).toMatch(/--mzizi-border:\s*#e7e5e0;/);
      expect(canon).toMatch(/--mzizi-border:\s*#2a2927;/);
      expect(canon).toMatch(/--mzizi-error:\s*#f2b8b5;/);
      expect(globals).toMatch(/--border:\s*var\(--mzizi-border\);/);
      expect(globals).toMatch(/--destructive:\s*var\(--mzizi-error\);/);
      expect(globals).not.toMatch(/--destructive:\s*#ff5252;/);
    });

    it("uses the Mzizi dark page surface and darker dark card", () => {
      expect(canon).toMatch(/\.dark,\s*\[data-theme="dark"\][\s\S]*?--surface-paper:\s*#1b1a17;/);
      expect(globals).toMatch(/--background:\s*var\(--surface-paper\);/);
      expect(globals).toMatch(/--card:\s*var\(--mzizi-card\);/);
      expect(canon).toMatch(/--mzizi-card:\s*#100f0e;/);
    });

    it("uses the Mzizi 2px focus ring width (high-contrast mode stays at 4px)", () => {
      expect(globals).toMatch(/--focus-ring-width:\s*2px;/);
      expect(globals).toMatch(/--focus-ring-width:\s*4px;/);
    });

    it("sets H1-H3 to the serif and H4-H6 to the sans family", () => {
      expect(globals).toMatch(/h1,\s*h2,\s*h3\s*\{\s*font-family:\s*var\(--font-heading\);/);
      expect(globals).toMatch(/h4,\s*h5,\s*h6\s*\{\s*font-family:\s*var\(--font-sans\);/);
    });
  });
});
