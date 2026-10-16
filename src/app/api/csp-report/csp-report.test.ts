import { beforeEach, describe, it, expect, vi } from "vitest";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

async function load() {
  vi.resetModules();
  return (await import("./route")).POST;
}

const post = (
  POST: Awaited<ReturnType<typeof load>>,
  body: string,
  contentLength: string | null = String(body.length),
) =>
  POST(
    new Request("https://weather.mukoko.com/api/csp-report", {
      method: "POST",
      body,
      headers:
        contentLength === null ? {} : { "content-length": contentLength },
    }) as never,
  );

const report = (over: Record<string, string> = {}) =>
  JSON.stringify({
    "csp-report": {
      "effective-directive": "img-src",
      "blocked-uri": "https://evil.example/p.png?lat=-17.123456",
      "document-uri":
        "https://weather.mukoko.com/west-paddock--ksy4dd7?lat=-17.12345",
      ...over,
    },
  });

describe("POST /api/csp-report", () => {
  beforeEach(() => warn.mockClear());

  it("logs directive, blocked HOST only and a coarsened page path; 204", async () => {
    const POST = await load();
    const res = await post(POST, report());
    expect(res.status).toBe(204);
    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(line).toContain("img-src");
    expect(line).toContain("evil.example");
    expect(line).not.toContain("p.png");
    expect(line).not.toContain("17.123");
    expect(line).not.toContain("ksy4dd7");
    expect(line).toContain("spot--ksy4");
  });

  it("rejects by Content-Length before reading the body", async () => {
    const POST = await load();
    expect((await post(POST, report(), "99999")).status).toBe(204);
    expect((await post(POST, report(), null)).status).toBe(204);
    expect((await post(POST, "x".repeat(9000))).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores malformed bodies", async () => {
    const POST = await load();
    expect((await post(POST, "not json")).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops browser-extension reports", async () => {
    const POST = await load();
    await post(POST, report({ "blocked-uri": "chrome-extension://abc/x.js" }));
    await post(
      POST,
      report({
        "blocked-uri": "https://x.example/a",
        "source-file": "moz-extension://abc/c.js",
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("dedupes an identical violation", async () => {
    const POST = await load();
    await post(POST, report());
    await post(POST, report());
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
