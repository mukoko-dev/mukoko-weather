/**
 * HazePanel — structural tests (source-level, no DOM renderer).
 * Pure visibility rules live in src/lib/haze.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "HazePanel.tsx"), "utf-8");

describe("HazePanel data flow", () => {
  it("is a client component", () => {
    expect(source.startsWith('"use client"')).toBe(true);
  });

  it("fetches the haze endpoint with lat/lon and aborts stale requests", () => {
    expect(source).toContain("/api/py/haze?lat=${lat}&lon=${lon}");
    expect(source).toContain("AbortController");
    expect(source).toContain("controller.abort()");
  });

  it("renders nothing on error, unavailable data, or when not worth showing", () => {
    expect(source).toContain('if (state.status === "error") return null;');
    expect(source).toContain(
      "if (!data.available || !data.level || !data.type) return null;",
    );
    expect(source).toContain(
      "isHazeWorthShowing(data.level, data.type, data.season)",
    );
  });
});

describe("HazePanel accessibility", () => {
  it("labels the section with its heading", () => {
    expect(source).toContain('aria-labelledby="haze-panel-heading"');
    expect(source).toContain('id="haze-panel-heading"');
  });

  it("uses a status skeleton while loading", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-label="Loading"');
  });

  it("hides decorative scale and icons from assistive tech", () => {
    expect(source).toContain('<div aria-hidden="true" className="flex gap-1">');
    expect(source).toContain('<span aria-hidden="true">');
  });

  it("gives the level to screen readers as text", () => {
    expect(source).toContain("sr-only");
    expect(source).toContain("HAZE_LEVEL_LABELS[level]");
  });
});

describe("HazePanel styling", () => {
  it("uses fauna classes for structure", () => {
    for (const cls of ["baobab", "giraffe", "gazelle", "dove", "chameleon"]) {
      expect(source).toContain(cls);
    }
  });

  it("has no hardcoded colours or inline styles", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(/text-(green|red|amber|orange|yellow)-\d/);
  });
});
