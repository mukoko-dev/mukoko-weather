/**
 * The record of changes not yet written to documents (#396): it round-trips,
 * holds settings and activity ids and a time (no credential, no place, no
 * name), refuses anything shaped wrong or oversized, and never throws on
 * blocked, missing or corrupt storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_PENDING_KEY, syncJournal } from "./sync-pending";

let data: Map<string, string>;

function stubStorage(overrides: Partial<Storage> = {}) {
  data = new Map();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    ...overrides,
  });
}

beforeEach(() => stubStorage());
afterEach(() => vi.unstubAllGlobals());

const record = () => ({
  at: 1_762_000_000_000,
  base: {
    theme: "system",
    selectedForecastModel: "best_match",
    selectedActivities: ["livestock", "gardening"],
  },
});

describe("the record", () => {
  it("is empty to begin with, round-trips, and clears", () => {
    expect(syncJournal.read()).toBeNull();
    syncJournal.write(record());
    expect(syncJournal.read()).toEqual(record());
    syncJournal.clear();
    expect(syncJournal.read()).toBeNull();
    expect(data.has(SYNC_PENDING_KEY)).toBe(false);
  });

  it("lives under one key and holds settings, activity ids and a time, nothing else", () => {
    syncJournal.write(record());
    expect([...data.keys()]).toEqual([SYNC_PENDING_KEY]);
    const raw = data.get(SYNC_PENDING_KEY) as string;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["at", "base"]);
    expect(raw).not.toMatch(/token|bearer|@|person|lat|lon|slug|home/i);
  });

  it("keeps only the fields it knows", () => {
    syncJournal.write({
      ...record(),
      base: { ...record().base, selectedLocation: "harare" },
    } as never);
    const read = syncJournal.read();
    expect(Object.keys(read?.base ?? {}).sort()).toEqual([
      "selectedActivities",
      "selectedForecastModel",
      "theme",
    ]);
  });

  it("does not store what is not worth keeping, and says so by reading null", () => {
    const bad: unknown[] = [
      { ...record(), at: Number.NaN },
      { ...record(), at: -1 },
      { ...record(), at: "now" },
      { ...record(), base: null },
      { ...record(), base: { ...record().base, theme: 4 } },
      {
        ...record(),
        base: { ...record().base, selectedForecastModel: "x".repeat(200) },
      },
      {
        ...record(),
        base: { ...record().base, selectedActivities: "livestock" },
      },
      {
        ...record(),
        base: { ...record().base, selectedActivities: [1, 2] },
      },
      {
        ...record(),
        base: {
          ...record().base,
          selectedActivities: Array.from({ length: 500 }, (_, i) => `a${i}`),
        },
      },
    ];
    for (const b of bad) {
      syncJournal.clear();
      syncJournal.write(b as never);
      expect(syncJournal.read(), JSON.stringify(b).slice(0, 80)).toBeNull();
    }
  });

  it("reads null for a corrupt value in storage, and a hand-edited one of the wrong shape", () => {
    for (const raw of [
      "{not json",
      "[]",
      "null",
      "42",
      JSON.stringify({ at: 1, base: "x" }),
      "x".repeat(100_000),
    ]) {
      data.set(SYNC_PENDING_KEY, raw);
      expect(syncJournal.read()).toBeNull();
    }
  });
});

describe("storage that does not work", () => {
  it("never throws when it is blocked", () => {
    stubStorage({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => syncJournal.write(record())).not.toThrow();
    expect(() => syncJournal.clear()).not.toThrow();
    expect(syncJournal.read()).toBeNull();
  });

  it("is a no-op with no browser", () => {
    vi.unstubAllGlobals();
    expect(() => syncJournal.write(record())).not.toThrow();
    expect(syncJournal.read()).toBeNull();
    expect(() => syncJournal.clear()).not.toThrow();
  });
});
