/**
 * Structural tests for the auth-gated /api/ai/* → /api/py/ai/* proxy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "[...path]/route.ts"), "utf-8");

describe("/api/ai proxy — auth gate", () => {
  it("validates the AuthKit session and 401s anonymous callers", () => {
    expect(source).toContain("withAuth()");
    expect(source).toContain("status: 401");
  });

  it("forwards the user identity, never the session cookie", () => {
    expect(source).toContain('"X-Mukoko-User-Id"');
    expect(source).toContain('"cookie"');
  });
});

describe("/api/ai proxy — internal shared secret (issue #92)", () => {
  it("stamps X-Mukoko-Internal when MUKOKO_INTERNAL_SECRET is configured", () => {
    expect(source).toContain("process.env.MUKOKO_INTERNAL_SECRET");
    expect(source).toContain('"X-Mukoko-Internal"');
  });

  it("remains optional — no secret, no header, deploys unaffected", () => {
    expect(source).toContain("if (internalSecret)");
  });
});
