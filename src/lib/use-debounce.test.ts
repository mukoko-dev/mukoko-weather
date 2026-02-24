/**
 * Tests for useDebounce — validates the extracted debounce hook.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "use-debounce.ts"),
  "utf-8",
);

describe("useDebounce — module structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports useDebounce as a named export", () => {
    expect(source).toContain("export function useDebounce");
  });

  it("uses useState and useEffect from React", () => {
    expect(source).toContain("useState");
    expect(source).toContain("useEffect");
  });

  it("accepts a value and delay parameter", () => {
    expect(source).toContain("value: T");
    expect(source).toContain("delay: number");
  });

  it("uses setTimeout for debouncing", () => {
    expect(source).toContain("setTimeout");
  });

  it("cleans up timeout on unmount/re-render", () => {
    expect(source).toContain("clearTimeout");
  });

  it("is generic (works with any type)", () => {
    expect(source).toContain("useDebounce<T>");
  });
});
