/**
 * ShamwariSignInCTA — shared anonymous sign-in prompt for Shamwari AI output.
 * Source-string introspection (project pattern).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "ShamwariSignInCTA.tsx"),
  "utf-8",
);

describe("ShamwariSignInCTA", () => {
  it("accepts title, body and accent props", () => {
    expect(source).toContain("title: string;");
    expect(source).toContain("body: string;");
    expect(source).toContain("accent: keyof typeof ACCENTS;");
  });

  it("uses the .baobab surface and .kudu-sm button", () => {
    expect(source).toContain("baobab");
    expect(source).toContain('className="kudu-sm"');
  });

  it("links to /auth/signin with returnTo encoded from the current path", () => {
    expect(source).toContain("/auth/signin?returnTo=");
    expect(source).toContain("encodeURIComponent(pathname)");
  });

  it("only ships static accent class strings (no dynamic Tailwind classes)", () => {
    expect(source).toContain('icon: "text-mineral-sodalite"');
    expect(source).toContain('icon: "text-tanzanite"');
    expect(source).not.toContain("`text-");
    expect(source).not.toContain("`border-");
  });

  it("labels its section by the title and marks the icon decorative", () => {
    expect(source).toContain("aria-label={title}");
    expect(source).toContain("<SparklesIcon");
  });
});
