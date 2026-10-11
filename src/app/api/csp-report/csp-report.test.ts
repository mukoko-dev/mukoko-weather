import { describe, it, expect, vi } from "vitest";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const { POST } = await import("./route");

const post = (body: string) =>
  POST(
    new Request("https://weather.mukoko.com/api/csp-report", {
      method: "POST",
      body,
    }) as never,
  );

describe("POST /api/csp-report", () => {
  it("logs directive, blocked origin and a sanitised page, answers 204", async () => {
    const res = await post(
      JSON.stringify({
        "csp-report": {
          "effective-directive": "img-src",
          "blocked-uri": "https://evil.example/p.png?lat=-17.123456",
          "document-uri":
            "https://weather.mukoko.com/west-paddock--ksy4dd7?lat=-17.12345",
        },
      }),
    );
    expect(res.status).toBe(204);
    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(line).toContain("img-src");
    expect(line).toContain("https://evil.example/p.png");
    expect(line).not.toContain("17.123");
    expect(line).not.toContain("ksy4dd7");
  });
  it("ignores malformed and oversize bodies", async () => {
    warn.mockClear();
    expect((await post("not json")).status).toBe(204);
    expect((await post("x".repeat(9000))).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });
});
