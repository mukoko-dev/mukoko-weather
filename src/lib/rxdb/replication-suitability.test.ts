import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const upsert = vi.fn();
vi.mock("./collections", () => ({
  preferencesCollection: vi.fn(),
  suitabilityRulesCollection: vi.fn(async () => ({ upsert })),
}));
vi.mock("./bridge", () => ({ getDeviceId: () => "id" }));

import { refreshSuitabilityRules } from "./replication";
import { DEFAULT_WEATHER_API_URL } from "../weather-api";

describe("refreshSuitabilityRules", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    upsert.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pulls the rules from the Rust Worker, never /api/py", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          rules: [{ key: "category:farming", conditions: [] }],
        }),
      ),
    );
    await refreshSuitabilityRules();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`${DEFAULT_WEATHER_API_URL}/v1/suitability`);
    expect(url).not.toContain("/api/py");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps the stale cache on a failed answer", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    await refreshSuitabilityRules();
    expect(upsert).not.toHaveBeenCalled();
  });
});
