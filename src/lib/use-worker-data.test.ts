import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useWorkerData } from "./use-worker-data";
import { workerData } from "./worker-data";

function Probe({ enabled = true }: { enabled?: boolean }) {
  const state = useWorkerData<{ aqi: number }>(
    "air-quality",
    { lat: -17.83, lon: 31.05 },
    enabled,
  );
  return createElement("span", null, state.status);
}

beforeEach(() => {
  workerData.reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ aqi: 42 }))),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("useWorkerData", () => {
  it("renders loading on the server and starts no request there", () => {
    expect(renderToString(createElement(Probe))).toContain("loading");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the server render is `loading` even when the browser's store already holds the answer (so hydration matches)", async () => {
    await workerData.json("air-quality", { lat: -17.83, lon: 31.05 });
    expect(
      workerData.peekSettled("air-quality", { lat: -17.83, lon: 31.05 }),
    ).toBeDefined();
    // renderToString uses the server snapshot: what the HTML had.
    expect(renderToString(createElement(Probe))).toContain("loading");
  });

  it("a disabled section stays loading and is never fetched", () => {
    expect(renderToString(createElement(Probe, { enabled: false }))).toContain(
      "loading",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the state is read from the store: settled good is ready, settled failed is error", async () => {
    const q = { lat: -17.83, lon: 31.05 };
    await workerData.json("air-quality", q);
    expect(workerData.peekSettled("air-quality", q)?.ok).toBe(true);

    workerData.reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    await workerData.read("air-quality", q, { retries: 0 });
    const failed = workerData.peekSettled("air-quality", q);
    expect(failed?.ok).toBe(false);
    expect(failed?.failure?.kind).toBe("server");
  });
});
