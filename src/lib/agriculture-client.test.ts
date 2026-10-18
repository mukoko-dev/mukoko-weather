import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AGRI_AI_CLIENT_TTL_MS,
  agriAIBody,
  fetchAgriAI,
  peekAgriAI,
  resetAgriAICache,
} from "./agriculture-client";

const LOC = {
  slug: "harare",
  name: "Harare",
  country: "ZW",
  elevation: 1490,
  lat: -17.83,
  lon: 31.05,
};

function okFetch(text: string, status = 200) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          text,
          source: "ai",
          cached: false,
          mode: "snapshot",
          generatedAt: "",
        }),
        { status },
      ),
  ) as unknown as typeof fetch;
}

describe("agriculture AI client", () => {
  beforeEach(() => resetAgriAICache());

  it("builds a stable body with ids and mode", () => {
    const body = JSON.parse(agriAIBody(LOC, ["crop-farming"], "briefing"));
    expect(body).toEqual({
      location: LOC,
      activities: ["crop-farming"],
      mode: "briefing",
    });
    expect(
      agriAIBody({ ...LOC, country: undefined }, [], "snapshot"),
    ).toContain('"country":""');
  });

  it("caches text per body and dedupes concurrent requests", async () => {
    const f = okFetch("Spray before noon.");
    const body = agriAIBody(LOC, ["crop-farming"], "snapshot");
    const [a, b] = await Promise.all([
      fetchAgriAI(body, f),
      fetchAgriAI(body, f),
    ]);
    expect(a).toBe("Spray before noon.");
    expect(b).toBe(a);
    expect(f).toHaveBeenCalledTimes(1);
    expect(peekAgriAI(body)).toBe("Spray before noon.");
    await fetchAgriAI(body, f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("expires after the TTL", async () => {
    const body = agriAIBody(LOC, [], "snapshot");
    await fetchAgriAI(body, okFetch("x"));
    expect(
      peekAgriAI(body, Date.now() + AGRI_AI_CLIENT_TTL_MS + 1),
    ).toBeUndefined();
  });

  it("rejects on HTTP errors and empty text, caching nothing", async () => {
    const body = agriAIBody(LOC, [], "snapshot");
    await expect(fetchAgriAI(body, okFetch("x", 429))).rejects.toThrow(
      "HTTP 429",
    );
    await expect(fetchAgriAI(body, okFetch("   "))).rejects.toThrow("empty");
    expect(peekAgriAI(body)).toBeUndefined();
  });

  it("posts to the auth-gated proxy only", async () => {
    const f = okFetch("y");
    await fetchAgriAI(agriAIBody(LOC, [], "snapshot"), f);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "/api/ai/agriculture",
    );
  });
});
