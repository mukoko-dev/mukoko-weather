/**
 * Tests for useFetchJson — the shared "fetch JSON for a url" hook. Mirrors the
 * source-level checks used by the other hook tests in src/lib.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "use-fetch-json.ts"), "utf-8");

describe("useFetchJson — module structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports useFetchJson as a named export", () => {
    expect(source).toContain("export function useFetchJson<T>(");
  });

  it("returns data, error and loading", () => {
    expect(source).toContain("export interface UseFetchJsonResult<T>");
    expect(source).toMatch(/data: T \| null;/);
    expect(source).toMatch(/error: Error \| null;/);
    expect(source).toMatch(/loading: boolean;/);
  });

  it("fetches through the shared fetchJsonOrThrow helper", () => {
    expect(source).toContain('from "./fetch-json"');
    expect(source).toContain(
      "fetchJsonOrThrow<T>(url, { signal: controller.signal })",
    );
  });

  it("aborts the in-flight request and ignores late results on cleanup", () => {
    expect(source).toContain("new AbortController()");
    expect(source).toContain("controller.abort()");
    expect(source).toContain("let active = true;");
    expect(source).toContain("if (active) setSettled");
  });

  it("accepts a null url to skip fetching", () => {
    expect(source).toContain("url: string | null");
    expect(source).toContain("if (key === null || url === null) return;");
  });
});
