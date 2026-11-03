/**
 * The mark left by the first "nobody is signed in" answer (#396). A single such
 * answer must never remove anything (AuthKit can fail to refresh a session and
 * say "no user" for a moment); the page removes the local copy of a person's
 * settings only when it hears it again on a LATER page load. The mark is one
 * number, a time: no person, no place, no credential. It round-trips, refuses
 * anything else, and never throws on blocked, missing or corrupt storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_SIGNED_OUT_KEY, signedOutMarker } from "./sync-signed-out";

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

const T = 1_762_000_000_000;

describe("the mark", () => {
  it("is empty to begin with, round-trips a time, and clears", () => {
    expect(signedOutMarker.read()).toBeNull();
    signedOutMarker.write(T);
    expect(signedOutMarker.read()).toBe(T);
    signedOutMarker.clear();
    expect(signedOutMarker.read()).toBeNull();
    expect(data.has(SYNC_SIGNED_OUT_KEY)).toBe(false);
  });

  it("is one key holding one number: no person, no place, no credential", () => {
    signedOutMarker.write(T);
    expect([...data.keys()]).toEqual([SYNC_SIGNED_OUT_KEY]);
    expect(data.get(SYNC_SIGNED_OUT_KEY)).toBe(String(T));
  });

  it("does not store a time that is not one, and reads such a value as nothing", () => {
    for (const bad of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
      signedOutMarker.write(bad);
      expect(data.has(SYNC_SIGNED_OUT_KEY), String(bad)).toBe(false);
    }
    for (const raw of ["", "now", "-5", "0", "1e999", "{}", "12abc", " "]) {
      data.set(SYNC_SIGNED_OUT_KEY, raw);
      expect(signedOutMarker.read(), JSON.stringify(raw)).toBeNull();
    }
    data.set(SYNC_SIGNED_OUT_KEY, "x".repeat(10_000));
    expect(signedOutMarker.read()).toBeNull();
  });

  it("never throws on blocked storage: reads nothing, writes and clears nothing", () => {
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
    expect(signedOutMarker.read()).toBeNull();
    expect(() => signedOutMarker.write(T)).not.toThrow();
    expect(() => signedOutMarker.clear()).not.toThrow();
  });

  it("is not in the credential's reach: no storage reference leaks into the sync modules", () => {
    // The sync modules are guarded against touching web storage at all
    // (`couch-sync-flag-off.test.ts`); this module is the one that does, for
    // a time and nothing else.
    expect(SYNC_SIGNED_OUT_KEY).toBe("mukoko-sync-signed-out");
  });
});
