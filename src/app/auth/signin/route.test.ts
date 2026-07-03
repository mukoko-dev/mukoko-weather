/**
 * Tests for the /auth/signin sanitizeReturnPath open-redirect guard.
 *
 * The sign-in route echoes a `returnTo` query param into the WorkOS sign-in
 * state so gated pages can send the user back where they started. That value
 * is attacker-controllable, so it must never resolve to an off-origin URL.
 */
import { describe, it, expect } from "vitest";
import { sanitizeReturnPath } from "./sanitize";

describe("sanitizeReturnPath", () => {
  it("accepts a plain in-app path", () => {
    expect(sanitizeReturnPath("/aviation")).toBe("/aviation");
  });

  it("accepts a path with a query string", () => {
    expect(sanitizeReturnPath("/history?days=30")).toBe("/history?days=30");
  });

  it("returns undefined for null / empty input", () => {
    expect(sanitizeReturnPath(null)).toBeUndefined();
    expect(sanitizeReturnPath("")).toBeUndefined();
  });

  it("rejects absolute URLs (scheme present)", () => {
    expect(sanitizeReturnPath("https://evil.com")).toBeUndefined();
    expect(sanitizeReturnPath("http://evil.com/aviation")).toBeUndefined();
  });

  it("rejects protocol-relative URLs (leading //)", () => {
    expect(sanitizeReturnPath("//evil.com")).toBeUndefined();
    expect(sanitizeReturnPath("//evil.com/path")).toBeUndefined();
  });

  it("rejects backslash protocol-relative bypass (/\\evil.com)", () => {
    // Browsers normalise the backslash to a forward slash, turning this into
    // //evil.com — a protocol-relative external redirect.
    expect(sanitizeReturnPath("/\\evil.com")).toBeUndefined();
    expect(sanitizeReturnPath("/\\/evil.com")).toBeUndefined();
  });

  it("rejects values that do not start with a slash", () => {
    expect(sanitizeReturnPath("evil.com")).toBeUndefined();
    expect(sanitizeReturnPath("javascript:alert(1)")).toBeUndefined();
  });
});
