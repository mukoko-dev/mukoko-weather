import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAIN_CLASS, WIDTH_CLASS } from "./page-width";

// The Next.js PageShell is the recipe; this app copies it, so a change to one
// without the other is a test failure, not a visual drift found later.
const shell = readFileSync(
  new URL("../../../src/components/layout/PageShell.tsx", import.meta.url),
  "utf8",
);

describe("page width", () => {
  it("uses the main column recipe of the Next.js PageShell", () => {
    expect(shell).toContain(`"${MAIN_CLASS}"`);
  });

  it("names the same widths with the same classes", () => {
    for (const [name, cls] of Object.entries(WIDTH_CLASS)) {
      expect(shell).toContain(`${name}: "${cls}"`);
    }
  });
});
