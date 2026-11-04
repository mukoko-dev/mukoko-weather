/**
 * The record of whose local sync databases exist (ids only): it lists, adds and
 * forgets; it holds nothing but person ids; it never throws on blocked,
 * missing or corrupt storage; and it is a no-op with no browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYNC_PEOPLE_KEY,
  forgetSyncPerson,
  recordSyncPerson,
  recordedSyncPeople,
} from "./sync-people-index";

const A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const B = "0190ffff-0000-7000-8000-00000000abcd";

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

describe("the record", () => {
  it("starts empty, adds a person once, keeps order, forgets one", () => {
    expect(recordedSyncPeople()).toEqual([]);
    recordSyncPerson(A);
    recordSyncPerson(A);
    recordSyncPerson(B);
    expect(recordedSyncPeople()).toEqual([A, B]);
    forgetSyncPerson(A);
    expect(recordedSyncPeople()).toEqual([B]);
    forgetSyncPerson(B);
    expect(recordedSyncPeople()).toEqual([]);
    // Nothing is left behind once the last one goes.
    expect(data.has(SYNC_PEOPLE_KEY)).toBe(false);
  });

  it("holds person ids and nothing else", () => {
    recordSyncPerson(A);
    recordSyncPerson(B);
    expect([...data.keys()]).toEqual([SYNC_PEOPLE_KEY]);
    const raw = data.get(SYNC_PEOPLE_KEY) as string;
    expect(JSON.parse(raw)).toEqual([A, B]);
    // No token, setting, activity, name or time can be in an array of ids.
    expect(raw).not.toMatch(/token|theme|activity|dark|light|@|bearer/i);
  });

  it("refuses an id that is not shaped like a person id", () => {
    for (const bad of ["", "UPPER", "a/b", "../x", "x".repeat(200), " a"]) {
      recordSyncPerson(bad);
    }
    expect(recordedSyncPeople()).toEqual([]);
    expect(data.size).toBe(0);
  });

  it("reads only well-formed ids out of whatever is stored", () => {
    data.set(SYNC_PEOPLE_KEY, JSON.stringify([A, 7, null, "BAD ID", B, A]));
    expect(recordedSyncPeople()).toEqual([A, B]);
    data.set(SYNC_PEOPLE_KEY, "{not json");
    expect(recordedSyncPeople()).toEqual([]);
    data.set(SYNC_PEOPLE_KEY, JSON.stringify({ a: 1 }));
    expect(recordedSyncPeople()).toEqual([]);
  });

  it("is bounded", () => {
    for (let i = 0; i < 20; i++) recordSyncPerson(`person-${i}`);
    expect(recordedSyncPeople().length).toBeLessThanOrEqual(8);
    expect(recordedSyncPeople()).toContain("person-19");
  });
});

describe("blocked, missing or full storage", () => {
  it("never throws when reading is blocked", () => {
    stubStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(recordedSyncPeople()).toEqual([]);
    expect(() => recordSyncPerson(A)).not.toThrow();
    expect(() => forgetSyncPerson(A)).not.toThrow();
  });

  it("never throws when writing is blocked or the quota is full", () => {
    stubStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(() => recordSyncPerson(A)).not.toThrow();
    expect(recordedSyncPeople()).toEqual([]);
  });

  it("does nothing with no browser (the server render)", () => {
    vi.stubGlobal("window", undefined);
    expect(recordedSyncPeople()).toEqual([]);
    expect(() => recordSyncPerson(A)).not.toThrow();
    expect(data.size).toBe(0);
  });
});
