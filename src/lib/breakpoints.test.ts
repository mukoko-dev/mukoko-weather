import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SM_BREAKPOINT_PX, SM_UP_QUERY } from "./breakpoints";

const ROOT = resolve(__dirname, "../..");
const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf-8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("the sm breakpoint, in one place", () => {
  it("is what Tailwind's theme says `sm:` means (and the app does not override it)", () => {
    // A class cannot read the constant, so the two are held together here: the
    // modal's `sm:` classes switch from sheet to centred dialog at exactly the
    // width its pull-down script stops (and the browser check tries 639 and 640).
    expect(css).not.toMatch(/--breakpoint-sm\s*:/);
    const theme = readFileSync(
      join(ROOT, "node_modules/tailwindcss/theme.css"),
      "utf-8",
    );
    const rem = theme.match(/--breakpoint-sm:\s*([\d.]+)rem;/)?.[1];
    expect(rem, "--breakpoint-sm in tailwindcss/theme.css").toBeDefined();
    expect(Number(rem) * 16).toBe(SM_BREAKPOINT_PX);
  });

  it("the query is min-width at that width", () => {
    expect(SM_UP_QUERY).toBe(`(min-width: ${SM_BREAKPOINT_PX}px)`);
  });

  it("no other source file spells the breakpoint as a media query of its own", () => {
    const offenders = walk(join(ROOT, "src"))
      .filter((file) => !file.endsWith("src/lib/breakpoints.ts"))
      .filter((file) =>
        new RegExp(`min-width:\\s*${SM_BREAKPOINT_PX}px`).test(
          readFileSync(file, "utf-8"),
        ),
      )
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
