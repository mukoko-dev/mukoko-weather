import { describe, expect, it } from "vitest";
import { applyHeaders, NO_STORE_HEADERS, SECURITY_HEADERS } from "./headers";

const resp = () =>
  new Response("body", { status: 201, headers: { "X-Keep": "1" } });

describe("applyHeaders", () => {
  it("adds security headers everywhere and keeps status, body and existing headers", async () => {
    const r = applyHeaders(resp(), "/anything");
    for (const [k, v] of Object.entries(SECURITY_HEADERS))
      expect(r.headers.get(k)).toBe(v);
    expect(r.status).toBe(201);
    expect(r.headers.get("X-Keep")).toBe("1");
    expect(await r.text()).toBe("body");
  });
  it("is noindex, no-referrer and framing-proof", () => {
    expect(SECURITY_HEADERS["X-Robots-Tag"]).toContain("noindex");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });
  it("forbids caching of the BFF, auth routes and the console page", () => {
    for (const p of [
      "/api/stations",
      "/api/stations/mws-0a0a0a0a/rotate-key",
      "/auth/signin",
      "/",
    ]) {
      expect(applyHeaders(resp(), p).headers.get("Cache-Control")).toBe(
        NO_STORE_HEADERS["Cache-Control"],
      );
    }
    expect(
      applyHeaders(resp(), "/_astro/x.js").headers.get("Cache-Control"),
    ).toBeNull();
  });
});
