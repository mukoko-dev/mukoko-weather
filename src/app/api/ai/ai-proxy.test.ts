/**
 * Structural tests for the auth-gated /api/ai/* proxy to the internal weather Worker.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "[[...path]]/route.ts"),
  "utf-8",
);

describe("/api/ai proxy — auth gate", () => {
  it("validates the AuthKit session and 401s anonymous callers", () => {
    expect(source).toContain("withAuth()");
    expect(source).toContain("status: 401");
  });

  it("forwards the user identity, never the session cookie", () => {
    // The headers are built in src/lib/ai-worker.ts from the id and address
    // only; the route never copies the request's headers.
    expect(source).not.toContain("req.headers.forEach");
    expect(source).toContain("userId");
  });
});

describe("/api/ai proxy — no Python and no shared secret any more", () => {
  it("does not forward to /api/py and stamps no X-Mukoko-Internal secret", () => {
    expect(source).not.toContain("/api/py");
    expect(source).not.toContain("MUKOKO_INTERNAL_SECRET");
    expect(source).not.toContain("X-Mukoko-Internal");
  });

  it("calls the internal weather Worker, never the browser's cookie", () => {
    expect(source).toContain("aiWorkerOrigin()");
    expect(source).toContain("WEATHER_SERVICE_API_KEY");
    expect(source).toContain("aiWorkerHeaders(");
  });
});
