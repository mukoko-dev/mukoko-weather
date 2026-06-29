/**
 * AISummary component tests — verifies the Phase 1D auth gate.
 *
 * Source-string introspection, matching the project pattern (Vitest runs in
 * Node without a DOM renderer).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "AISummary.tsx"), "utf-8");

describe("AISummary — Phase 1D auth gating", () => {
  it("exports an AISummaryUser type so client callers don't import WorkOS types", () => {
    expect(source).toContain("export interface AISummaryUser");
  });

  it("accepts a `user` prop in its Props interface", () => {
    expect(source).toContain("user: AISummaryUser | null");
  });

  it("destructures `user` from props in the component signature", () => {
    expect(source).toContain("export function AISummary({ weather, location, user");
  });

  it("renders the sign-in CTA branch when user is null", () => {
    expect(source).toContain("AISummarySignInCTA");
    expect(source).toContain("if (!isAuthed)");
  });

  it("CTA copy mentions the location name", () => {
    expect(source).toContain("AI insights for {locationName}");
  });

  it("CTA uses the .baobab fauna surface and .kudu-sm button", () => {
    expect(source).toContain('className="baobab');
    expect(source).toContain('className="kudu-sm"');
  });

  it("CTA links to /auth/signin with a sanitised returnTo query param", () => {
    expect(source).toContain("/auth/signin?returnTo=");
    expect(source).toContain("encodeURIComponent(pathname)");
  });

  it("calls the auth-gated /api/ai/* proxy, not /api/py/ai/* directly", () => {
    expect(source).toContain('"/api/ai"');
    expect(source).not.toContain('"/api/py/ai"');
  });

  it("skips the fetch effect when user is anonymous (no upstream call)", () => {
    expect(source).toContain("if (!isAuthed) return;");
  });
});
