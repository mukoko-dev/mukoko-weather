import { describe, it, expect, beforeEach } from "vitest";
import {
  getPersonSyncOverflow,
  isPersonSyncActive,
  setPersonSyncActive,
  setPersonSyncOverflow,
} from "./person-preferences-state";

beforeEach(() => setPersonSyncActive(false));

describe("person-preferences-state", () => {
  it("starts inactive with nothing over the cap", () => {
    expect(isPersonSyncActive()).toBe(false);
    expect(getPersonSyncOverflow()).toEqual([]);
  });

  it("keeps the latest overflow as a copy", () => {
    const ids = ["a", "b"];
    setPersonSyncOverflow(ids);
    ids.push("c");
    expect(getPersonSyncOverflow()).toEqual(["a", "b"]);
  });

  it("forgets the overflow when the sync stops, so a signed-out page reports none", () => {
    setPersonSyncActive(true);
    setPersonSyncOverflow(["a"]);
    expect(isPersonSyncActive()).toBe(true);
    setPersonSyncActive(false);
    expect(isPersonSyncActive()).toBe(false);
    expect(getPersonSyncOverflow()).toEqual([]);
  });
});
