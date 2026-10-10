/**
 * Tests for the /profile data layer — identity.persons is the source of truth
 * (Mukoko ecosystem standard), with per-field session fallbacks, fail-soft
 * reads, own-record-only writes, and capability-filtered organisations.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const personsFindOne = vi.fn();
const personsUpdateOne = vi.fn();
const membershipsAggregate = vi.fn();

vi.mock("./db", () => ({
  personsCollection: () => ({
    findOne: personsFindOne,
    updateOne: personsUpdateOne,
  }),
  entityMembershipsCollection: () => ({
    aggregate: (pipeline: unknown) => ({
      toArray: () => membershipsAggregate(pipeline),
    }),
  }),
}));

vi.mock("./observability", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { getMyProfile, getMyOrganizations, updateMyName } from "./profile";

const user = {
  id: "user_01",
  email: "bryan@nyuchi.com",
  firstName: "Session",
  lastName: "Claim",
  profilePictureUrl: "https://workos.example/pic.png",
};

beforeEach(() => {
  personsFindOne.mockReset();
  personsUpdateOne.mockReset();
  membershipsAggregate.mockReset();
});

describe("getMyProfile", () => {
  it("reads the caller's own active record by workosUserId", async () => {
    personsFindOne.mockResolvedValue(null);
    await getMyProfile(user);
    expect(personsFindOne.mock.calls[0][0]).toEqual({
      workosUserId: "user_01",
      isActive: { $ne: false },
    });
  });

  it("prefers identity.persons fields over the session claims", async () => {
    personsFindOne.mockResolvedValue({
      _id: "person-1",
      givenName: "Bryan",
      familyName: "Fawcett",
      picture: "https://profile-images.mukoko.com/p.jpg",
      interests: ["farming", 3],
    });
    const p = await getMyProfile(user);
    expect(p.personId).toBe("person-1");
    expect(p.givenName).toBe("Bryan");
    expect(p.familyName).toBe("Fawcett");
    expect(p.picture).toBe("https://profile-images.mukoko.com/p.jpg");
    expect(p.interests).toEqual(["farming"]);
  });

  it("falls back per-field to the session claims", async () => {
    personsFindOne.mockResolvedValue({ _id: "person-1", givenName: "Bryan" });
    const p = await getMyProfile(user);
    expect(p.givenName).toBe("Bryan");
    expect(p.familyName).toBe("Claim");
    expect(p.picture).toBe("https://workos.example/pic.png");
  });

  it("is fail-soft: a DB error yields the session-claim profile", async () => {
    personsFindOne.mockRejectedValue(new Error("down"));
    const p = await getMyProfile(user);
    expect(p.personId).toBeNull();
    expect(p.givenName).toBe("Session");
  });
});

describe("getMyOrganizations", () => {
  it("returns [] without a personId and never queries", async () => {
    expect(await getMyOrganizations(null)).toEqual([]);
    expect(membershipsAggregate).not.toHaveBeenCalled();
  });

  it("scopes to the person's active memberships and drops capability-less roles", async () => {
    membershipsAggregate.mockResolvedValue([
      { entityId: "e1", role: "founder", entityName: "Nyuchi", title: null },
      { entityId: "e2", role: "stranger", entityName: "Other" },
    ]);
    const orgs = await getMyOrganizations("person-1");
    const match = membershipsAggregate.mock.calls[0][0][0].$match;
    expect(match.personId).toBe("person-1");
    expect(match.isActive).toBe(true);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({
      entityId: "e1",
      entityName: "Nyuchi",
      capabilities: ["entity:read", "entity:manage", "entity:members"],
    });
  });

  it("is fail-soft: a DB error yields []", async () => {
    membershipsAggregate.mockRejectedValue(new Error("down"));
    expect(await getMyOrganizations("person-1")).toEqual([]);
  });
});

describe("updateMyName", () => {
  it("updates only the caller's record, allowlisted fields, no upsert", async () => {
    personsUpdateOne.mockResolvedValue({ matchedCount: 1 });
    expect(await updateMyName("user_01", "Bryan", "Fawcett")).toBe(true);
    const [filter, update, options] = personsUpdateOne.mock.calls[0];
    expect(filter).toEqual({
      workosUserId: "user_01",
      isActive: { $ne: false },
    });
    expect(Object.keys(update.$set).sort()).toEqual(
      ["familyName", "givenName", "name", "updatedAt"].sort(),
    );
    expect(update.$set.name).toBe("Bryan Fawcett");
    expect(options).toBeUndefined();
  });

  it("returns false when no record matched or the write throws", async () => {
    personsUpdateOne.mockResolvedValue({ matchedCount: 0 });
    expect(await updateMyName("user_01", "A", "")).toBe(false);
    personsUpdateOne.mockRejectedValue(new Error("down"));
    expect(await updateMyName("user_01", "A", "")).toBe(false);
  });
});
