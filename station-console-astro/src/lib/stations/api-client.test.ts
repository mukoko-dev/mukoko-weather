import { describe, expect, it, vi } from "vitest";
import { ConsoleApi, ConsoleApiError } from "./api-client";

function api(res: { status?: number; body?: unknown }) {
  const f = vi.fn(
    async () =>
      new Response(JSON.stringify(res.body ?? {}), {
        status: res.status ?? 200,
      }),
  );
  return { f, client: new ConsoleApi(f as unknown as typeof fetch) };
}
const call = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.at(-1) as unknown as [
    string,
    RequestInit & { headers: Record<string, string> },
  ];

describe("ConsoleApi", () => {
  it("only ever calls same-origin relative BFF paths with same-origin credentials", async () => {
    const { f, client } = api({ body: { stations: [] } });
    await client.list();
    const [url, init] = call(f);
    expect(url).toBe("/api/stations");
    expect(init.credentials).toBe("same-origin");
  });
  it("sends the station key as a header, never in the URL", async () => {
    const { f, client } = api({ body: {} });
    await client.status("mws-0a0a0a0a", "super-secret");
    const [url, init] = call(f);
    expect(url).toBe("/api/stations/mws-0a0a0a0a");
    expect(init.headers["X-Station-Key"]).toBe("super-secret");
    expect(url).not.toContain("super-secret");
  });
  it("posts JSON for register, readings and rotation", async () => {
    const { f, client } = api({ body: { stationId: "x" } });
    await client.register({
      name: "F",
      lat: 1,
      lon: 2,
      stationType: "digital",
    });
    expect(call(f)[1].headers["Content-Type"]).toBe("application/json");
    await client.submitReading("mws-0a0a0a0a", { windKph: 1 });
    expect(call(f)[0]).toBe("/api/stations/mws-0a0a0a0a/readings");
    await client.rotateKey("mws-0a0a0a0a");
    expect(call(f)[0]).toBe("/api/stations/mws-0a0a0a0a/rotate-key");
    expect(call(f)[1].method).toBe("POST");
  });
  it("turns server errors into ConsoleApiError with the server message", async () => {
    const { client } = api({
      status: 400,
      body: { error: "Latitude must be a number" },
    });
    await expect(
      client.register({ name: "F", lat: 1, lon: 2, stationType: "digital" }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Latitude must be a number",
    });
    const noBody = api({ status: 503 });
    await expect(noBody.client.list()).rejects.toBeInstanceOf(ConsoleApiError);
  });
});
