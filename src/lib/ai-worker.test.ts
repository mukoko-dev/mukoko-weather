import { describe, it, expect } from "vitest";
import {
  AI_WORKER_ROUTES,
  MAX_AI_BODY_BYTES,
  aiWorkerHeaders,
  aiWorkerOrigin,
  aiWorkerPath,
  visitorIp,
} from "./ai-worker";

describe("aiWorkerPath", () => {
  it("maps the bare /api/ai to the Worker's summary route", () => {
    expect(aiWorkerPath("")).toBe("/internal/ai/summary");
  });

  it("has no route for a subpath it does not serve", () => {
    for (const sub of [
      "prompts",
      "suggested-rules",
      "constructor",
      "__proto__",
    ]) {
      expect(aiWorkerPath(sub)).toBeUndefined();
    }
  });

  it("only ever points at the internal Worker's /internal/ai/ paths", () => {
    for (const path of Object.values(AI_WORKER_ROUTES)) {
      expect(path.startsWith("/internal/ai/")).toBe(true);
    }
  });

  it("matches the Worker's body cap", () => {
    expect(MAX_AI_BODY_BYTES).toBe(64 * 1024);
  });
});

describe("aiWorkerOrigin", () => {
  it("accepts a bare https origin, with or without a trailing slash", () => {
    expect(aiWorkerOrigin("https://weather-internal.mukoko.com")).toBe(
      "https://weather-internal.mukoko.com",
    );
    expect(aiWorkerOrigin(" https://weather-internal.mukoko.com/ ")).toBe(
      "https://weather-internal.mukoko.com",
    );
  });

  it("accepts plain http only for localhost", () => {
    expect(aiWorkerOrigin("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(aiWorkerOrigin("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(aiWorkerOrigin("http://weather-internal.mukoko.com")).toBeNull();
  });

  it("refuses anything that is not a bare origin, so the service key cannot be sent elsewhere", () => {
    for (const bad of [
      undefined,
      "",
      "   ",
      "not a url",
      "ftp://x.example",
      "https://user:pass@x.example",
      "https://x.example/path",
      "https://x.example?x=1",
      "https://x.example#frag",
    ]) {
      expect(aiWorkerOrigin(bad as string | undefined)).toBeNull();
    }
  });
});

describe("visitorIp", () => {
  it("takes the first x-forwarded-for entry", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(visitorIp(h)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip, then to null", () => {
    expect(visitorIp(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
    expect(visitorIp(new Headers())).toBeNull();
    expect(visitorIp(new Headers({ "x-forwarded-for": "" }))).toBeNull();
  });

  it("refuses an over-long value", () => {
    expect(
      visitorIp(new Headers({ "x-forwarded-for": "9".repeat(65) })),
    ).toBeNull();
  });
});

describe("aiWorkerHeaders", () => {
  it("carries the key, the person and the address, and nothing else personal", () => {
    const h = aiWorkerHeaders({
      key: "k",
      userId: "user_1",
      ip: "203.0.113.9",
    });
    expect(h.get("authorization")).toBe("Bearer k");
    expect(h.get("x-mukoko-user-id")).toBe("user_1");
    expect(h.get("x-mukoko-client-ip")).toBe("203.0.113.9");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("cookie")).toBeNull();
    expect(h.get("x-mukoko-user-email")).toBeNull();
  });

  it("omits the address header when there is none", () => {
    const h = aiWorkerHeaders({ key: "k", userId: "user_1", ip: null });
    expect(h.get("x-mukoko-client-ip")).toBeNull();
  });
});
