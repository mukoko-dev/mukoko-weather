/**
 * Tests for the shared JSON fetch helpers. Global fetch is mocked so these
 * run in the Node test environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fetchJson, fetchJsonOrThrow, FetchJsonError } from "./fetch-json";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** A fetch mock that only settles when its signal aborts. */
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const fail = () =>
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) return fail();
    signal?.addEventListener("abort", fail);
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchJson — success", () => {
  it("resolves to the parsed JSON body on an OK response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ rules: [1, 2] }), { status: 200 }),
    );
    await expect(fetchJson<{ rules: number[] }>("/api/x")).resolves.toEqual({
      rules: [1, 2],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sends accept: application/json by default", async () => {
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await fetchJson("/api/x");
    const headers = new Headers(mockFetch.mock.calls[0][1].headers);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("forwards caller init and keeps a caller-supplied accept header", async () => {
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await fetchJson("/api/x", {
      init: {
        method: "POST",
        headers: { "x-test": "1", accept: "text/plain" },
      },
    });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-test")).toBe("1");
    expect(headers.get("accept")).toBe("text/plain");
  });
});

describe("fetchJson — failures resolve to null", () => {
  it("returns null on a 500 response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(fetchJson("/api/x")).resolves.toBeNull();
  });

  it("returns null on a network error", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchJson("/api/x")).resolves.toBeNull();
  });

  it("returns null when the body is not valid JSON", async () => {
    mockFetch.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(fetchJson("/api/x")).resolves.toBeNull();
  });

  it("returns null when the request times out", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementationOnce(hangingFetch);
    const pending = fetchJson("/api/x", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
  });

  it("returns null when the caller signal aborts", async () => {
    mockFetch.mockImplementationOnce(hangingFetch);
    const controller = new AbortController();
    const pending = fetchJson("/api/x", { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });
});

describe("fetchJsonOrThrow", () => {
  it("throws FetchJsonError carrying the status on a non-OK response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const err = await fetchJsonOrThrow("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchJsonError);
    expect((err as FetchJsonError).status).toBe(404);
  });

  it("returns the parsed body on success", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(fetchJsonOrThrow<{ ok: boolean }>("/api/x")).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects on a timeout instead of resolving null", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementationOnce(hangingFetch);
    const pending = fetchJsonOrThrow("/api/x", { timeoutMs: 500 });
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    mockFetch.mockImplementationOnce(hangingFetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchJsonOrThrow("/api/x", { signal: controller.signal }),
    ).rejects.toBeDefined();
  });

  it("honours init.signal as a caller signal", async () => {
    mockFetch.mockImplementationOnce(hangingFetch);
    const controller = new AbortController();
    const pending = fetchJsonOrThrow("/api/x", {
      init: { signal: controller.signal },
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe("fetchJson — module structure", () => {
  const source = readFileSync(resolve(__dirname, "fetch-json.ts"), "utf-8");

  it("exports fetchJson, fetchJsonOrThrow and FetchJsonError", () => {
    expect(source).toContain("export async function fetchJson<T>(");
    expect(source).toContain("export async function fetchJsonOrThrow<T>(");
    expect(source).toContain("export class FetchJsonError");
  });

  it("has no framework or app imports (safe for the Edge embed route)", () => {
    expect(source).not.toMatch(/^import /m);
  });
});
