import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `syncSeasons` keys a row by (country, English name). A season whose English
 * name changes would leave the old row behind with overlapping months, and
 * `getSeasonFromDb` takes the first row for a month, so the old one could
 * win. The sync therefore removes, for each country the seed defines, the rows
 * the seed no longer has.
 */
const calls: { op: string; arg: unknown }[] = [];
const fake = {
  updateMany: vi.fn(async (...arg: unknown[]) => {
    calls.push({ op: "updateMany", arg });
  }),
  bulkWrite: vi.fn(async (ops: unknown[]) => {
    calls.push({ op: "bulkWrite", arg: ops });
  }),
};

vi.mock("./mongo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mongo")>()),
  weatherDb: () => ({ collection: () => fake }),
}));

import { syncSeasons } from "./db";
import type { SeasonDoc } from "./seed-seasons";

const doc = (countryCode: string, name: string): SeasonDoc => ({
  countryCode,
  name,
  localName: name,
  months: [1],
  hemisphere: "south",
  description: "d",
});

beforeEach(() => {
  calls.length = 0;
});

describe("syncSeasons", () => {
  it("upserts every seed row on (country, name)", async () => {
    await syncSeasons([doc("ZW", "Summer rains"), doc("ZW", "Cool dry")]);
    const bulk = calls.filter((c) => c.op === "bulkWrite");
    const upserts = bulk[0].arg as {
      updateOne: { filter: unknown; upsert: boolean };
    }[];
    expect(upserts.map((o) => o.updateOne.filter)).toEqual([
      { countryCode: "ZW", name: "Summer rains" },
      { countryCode: "ZW", name: "Cool dry" },
    ]);
    expect(upserts.every((o) => o.updateOne.upsert)).toBe(true);
  });

  it("removes a country's rows the seed no longer has, and only for countries it defines", async () => {
    await syncSeasons([
      doc("ZW", "Summer rains"),
      doc("ZW", "Cool dry"),
      doc("KE", "Long rains"),
    ]);
    const bulk = calls.filter((c) => c.op === "bulkWrite");
    expect(bulk).toHaveLength(2);
    // Deleted after the upserts, so a failure to write never leaves a country empty.
    expect(bulk[1].arg).toEqual([
      {
        deleteMany: {
          filter: {
            countryCode: "ZW",
            name: { $nin: ["Summer rains", "Cool dry"] },
          },
        },
      },
      {
        deleteMany: {
          filter: { countryCode: "KE", name: { $nin: ["Long rains"] } },
        },
      },
    ]);
    // No filter reaches a country the seed does not define (the AI rows for GB).
    expect(JSON.stringify(bulk[1].arg)).not.toContain("GB");
  });

  it("writes nothing for an empty seed", async () => {
    await syncSeasons([]);
    expect(calls.filter((c) => c.op === "bulkWrite")).toHaveLength(0);
  });
});
