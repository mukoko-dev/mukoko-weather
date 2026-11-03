import { describe, expect, it, vi } from "vitest";

const getSeasonForDate = vi.fn();
vi.mock("@/lib/db", () => ({
  getSeasonForDate: (...a: unknown[]) => getSeasonForDate(...a),
}));

import { SEED_SEASON_BUDGET_MS, seasonWithinBudget } from "./place-seed-server";

describe("seasonWithinBudget", () => {
  it("returns the database season when it answers in time", async () => {
    getSeasonForDate.mockResolvedValueOnce({
      name: "Rainy",
      localName: "Zhizha",
      description: "",
    });
    const season = await seasonWithinBudget("ZW", -17.8, 200);
    expect(season.localName).toBe("Zhizha");
  });

  it("falls back to the hemisphere's default when the database is slow", async () => {
    getSeasonForDate.mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    const season = await seasonWithinBudget("ZW", -17.8, 30);
    expect(Date.now() - started).toBeLessThan(500);
    expect(typeof season.name).toBe("string");
    expect(season.name.length).toBeGreaterThan(0);
  });

  it("falls back when the database fails", async () => {
    getSeasonForDate.mockRejectedValueOnce(new Error("down"));
    const season = await seasonWithinBudget("ZW", -17.8, 200);
    expect(season.name.length).toBeGreaterThan(0);
  });

  it("keeps the budget well under the old multi-second waits", () => {
    expect(SEED_SEASON_BUDGET_MS).toBeLessThanOrEqual(1000);
  });
});
