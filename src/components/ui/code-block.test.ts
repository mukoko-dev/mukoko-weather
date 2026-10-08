/**
 * CodeBlock — code sample surface. Verified by reading the source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "code-block.tsx"), "utf-8");

describe("CodeBlock", () => {
  it("renders the code as text children, never as markup", () => {
    expect(source).toContain("{code}");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it("uses the tortoise surface and global token colours", () => {
    expect(source).toContain("mt-4 tortoise");
    expect(source).toContain("text-text-primary");
  });

  it("is keyboard-scrollable with an accessible name", () => {
    expect(source).toContain("tabIndex={0}");
    expect(source).toContain("aria-label");
  });

  it("has no inline styles or hardcoded colours", () => {
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
