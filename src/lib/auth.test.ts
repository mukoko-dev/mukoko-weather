import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks — must exist before the SUT imports `./db` ──────────────
const mockPersons = vi.hoisted(() => ({
  findOne: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  countDocuments: vi.fn().mockResolvedValue(0),
}));

const mockCredentials = vi.hoisted(() => ({
  findOne: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
}));

const mockActivityLog = vi.hoisted(() => ({
  insertOne: vi.fn(),
}));

// Re-export the real `stampPlatformFields` so we exercise its UUID/timestamp
// behaviour rather than reimplementing it inside the test.
vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stampPlatformFields: actual.stampPlatformFields,
    personsCollection: () => mockPersons,
    credentialsCollection: () => mockCredentials,
    activityLogCollection: () => mockActivityLog,
  };
});

const mockWithAuth = vi.hoisted(() => vi.fn());

// AuthKit is server-only and imports Next.js internals — stub it so importing
// auth.ts in a unit test environment doesn't blow up.
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: mockWithAuth,
  getSignInUrl: vi.fn(),
  signOut: vi.fn(),
}));

// `redirect()` throws a control-flow signal in Next.js. Emulate that so tests
// can assert the target and confirm requireUser never returns for anon users.
const mockRedirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

import { upsertPlatformPerson, requireUser, type WorkOSUser } from "./auth";

const sampleUser: WorkOSUser = {
  id: "user_01HZX",
  email: "bryan@nyuchi.com",
  emailVerified: true,
  firstName: "Bryan",
  lastName: "Fawcett",
  profilePictureUrl: "https://example.com/avatar.png",
};

describe("upsertPlatformPerson", () => {
  beforeEach(() => {
    mockPersons.findOne.mockReset();
    mockPersons.insertOne.mockReset();
    mockPersons.updateOne.mockReset();
    mockPersons.countDocuments.mockReset().mockResolvedValue(0);
    mockCredentials.findOne.mockReset();
    mockCredentials.insertOne.mockReset();
    mockCredentials.updateOne.mockReset();
    mockActivityLog.insertOne.mockReset();
  });

  it("creates a new person when workosUserId is not in the DB", async () => {
    mockPersons.findOne.mockResolvedValue(null); // both lookups miss
    mockCredentials.findOne.mockResolvedValue(null);

    const result = await upsertPlatformPerson(sampleUser);

    expect(result.created).toBe(true);
    expect(mockPersons.insertOne).toHaveBeenCalledTimes(1);

    const insertedDoc = mockPersons.insertOne.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedDoc.workosUserId).toBe(sampleUser.id);
    expect(insertedDoc.email).toBe(sampleUser.email);
    expect(insertedDoc.emailVerified).toBe(true);
    expect(insertedDoc.givenName).toBe("Bryan");
    expect(insertedDoc.familyName).toBe("Fawcett");
    expect(insertedDoc.picture).toBe(sampleUser.profilePictureUrl);
    expect(insertedDoc.isActive).toBe(true);
    expect(insertedDoc.phoneNumberVerified).toBe(false);
    expect(insertedDoc._schemaVersion).toBe("v3.1");
    expect(typeof insertedDoc._id).toBe("string");
    expect(insertedDoc.createdAt).toBeInstanceOf(Date);
    expect(insertedDoc.updatedAt).toBeInstanceOf(Date);
    expect((insertedDoc.bundu as { countryCode: string }).countryCode).toBe("ZW");

    // Returned person doc must include the required fields the validator demands.
    expect(result.person._id).toBe(insertedDoc._id);
    expect(result.person.workosUserId).toBe(sampleUser.id);
    expect(result.person.isActive).toBe(true);
    expect(result.person.phoneNumberVerified).toBe(false);
  });

  it("updates the existing person when workosUserId matches", async () => {
    const existingDoc = {
      _id: "person-uuid-123",
      _schemaVersion: "v3.1",
      workosUserId: sampleUser.id,
      email: "old@nyuchi.com",
      emailVerified: false,
      phoneNumberVerified: true,
      isActive: true,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
      bundu: { countryCode: "ZW" },
    };
    mockPersons.findOne.mockResolvedValueOnce(existingDoc); // first lookup hits
    mockCredentials.findOne.mockResolvedValue(null);

    const result = await upsertPlatformPerson(sampleUser);

    expect(result.created).toBe(false);
    expect(result.person._id).toBe(existingDoc._id);
    expect(mockPersons.insertOne).not.toHaveBeenCalled();
    expect(mockPersons.updateOne).toHaveBeenCalledTimes(1);

    const [filter, update] = mockPersons.updateOne.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter._id).toBe(existingDoc._id);
    expect(update.$set.email).toBe(sampleUser.email); // refreshed from WorkOS
    expect(update.$set.emailVerified).toBe(true);
    expect(update.$set.workosUserId).toBe(sampleUser.id);
    expect(update.$set.isActive).toBe(true);
  });

  it("claims legacy email-only person records (no workosUserId)", async () => {
    const legacyDoc = {
      _id: "legacy-person-uuid",
      _schemaVersion: "v3.1",
      email: sampleUser.email,
      emailVerified: false,
      phoneNumberVerified: false,
      isActive: true,
      createdAt: new Date("2023-01-01T00:00:00Z"),
      updatedAt: new Date("2023-01-01T00:00:00Z"),
      bundu: { countryCode: "ZW" },
    };
    mockPersons.findOne
      .mockResolvedValueOnce(null) // workosUserId lookup misses
      .mockResolvedValueOnce(legacyDoc); // email fallback hits
    mockCredentials.findOne.mockResolvedValue(null);

    const result = await upsertPlatformPerson(sampleUser);

    expect(result.created).toBe(false);
    expect(result.person._id).toBe(legacyDoc._id);
    expect(mockPersons.insertOne).not.toHaveBeenCalled();
    expect(mockPersons.updateOne).toHaveBeenCalledTimes(1);
  });

  it("writes an activityLog entry on every call", async () => {
    mockPersons.findOne.mockResolvedValue(null);
    mockCredentials.findOne.mockResolvedValue(null);

    await upsertPlatformPerson(sampleUser);
    expect(mockActivityLog.insertOne).toHaveBeenCalledTimes(1);

    const firstLog = mockActivityLog.insertOne.mock.calls[0][0] as Record<string, unknown>;
    expect(firstLog.eventType).toBe("signup"); // brand-new person → signup
    expect(firstLog.surfaceContext).toBe("mukoko-weather");
    expect(firstLog.provider).toBe("workos");
    expect(firstLog.success).toBe(true);
    expect(firstLog._schemaVersion).toBe("v3.1");

    // Now simulate a returning user — eventType should flip to "signin".
    mockPersons.findOne.mockResolvedValueOnce({
      _id: "existing-id",
      _schemaVersion: "v3.1",
      workosUserId: sampleUser.id,
      phoneNumberVerified: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      bundu: { countryCode: "ZW" },
    });
    mockActivityLog.insertOne.mockClear();

    await upsertPlatformPerson(sampleUser);
    expect(mockActivityLog.insertOne).toHaveBeenCalledTimes(1);
    const secondLog = mockActivityLog.insertOne.mock.calls[0][0] as Record<string, unknown>;
    expect(secondLog.eventType).toBe("signin");
  });

  it("never creates duplicate credentials for the same person", async () => {
    mockPersons.findOne.mockResolvedValue(null);
    // Existing credential already present for this (person, workos, oauth_token)
    mockCredentials.findOne.mockResolvedValue({
      _id: "existing-cred-uuid",
      personId: "ignored",
      provider: "workos",
      credentialType: "oauth_token",
    });

    await upsertPlatformPerson(sampleUser);

    expect(mockCredentials.insertOne).not.toHaveBeenCalled();
    expect(mockCredentials.updateOne).toHaveBeenCalledTimes(1);

    const [filter, update] = mockCredentials.updateOne.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter._id).toBe("existing-cred-uuid");
    expect(update.$set.providerUserId).toBe(sampleUser.id);
    expect(update.$set.isActive).toBe(true);
  });

  it("inserts a credential doc when none exists, deduped by (personId, provider, type)", async () => {
    mockPersons.findOne.mockResolvedValue(null);
    mockCredentials.findOne.mockResolvedValue(null);

    await upsertPlatformPerson(sampleUser);

    expect(mockCredentials.findOne).toHaveBeenCalledWith({
      personId: expect.any(String),
      provider: "workos",
      credentialType: "oauth_token",
    });
    expect(mockCredentials.insertOne).toHaveBeenCalledTimes(1);

    const credDoc = mockCredentials.insertOne.mock.calls[0][0] as Record<string, unknown>;
    expect(credDoc.provider).toBe("workos");
    expect(credDoc.credentialType).toBe("oauth_token");
    expect(credDoc.providerUserId).toBe(sampleUser.id);
    expect(credDoc.isActive).toBe(true);
    expect(typeof credDoc.personId).toBe("string");
  });

  it("returns the persons doc with all required platform fields", async () => {
    mockPersons.findOne.mockResolvedValue(null);
    mockCredentials.findOne.mockResolvedValue(null);

    const { person } = await upsertPlatformPerson(sampleUser);

    // The validator on identity.persons requires _id, _schemaVersion,
    // isActive, emailVerified, phoneNumberVerified, createdAt, updatedAt.
    expect(typeof person._id).toBe("string");
    expect(person._schemaVersion).toBe("v3.1");
    expect(person.isActive).toBe(true);
    expect(person.emailVerified).toBe(true);
    expect(person.phoneNumberVerified).toBe(false);
    expect(person.createdAt).toBeInstanceOf(Date);
    expect(person.updatedAt).toBeInstanceOf(Date);
    expect(person.workosUserId).toBe(sampleUser.id);
  });

  it("throws when the WorkOS user has no id", async () => {
    await expect(
      upsertPlatformPerson({ id: "", email: "x@y.com" } as WorkOSUser),
    ).rejects.toThrow(/workosUser\.id is required/);
  });
});

describe("requireUser", () => {
  beforeEach(() => {
    mockWithAuth.mockReset();
    mockRedirect.mockClear();
  });

  it("returns the signed-in user without redirecting", async () => {
    mockWithAuth.mockResolvedValue({ user: sampleUser });

    const user = await requireUser("/aviation");

    expect(user).toEqual(sampleUser);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects anonymous users through /auth/signin with an encoded returnTo", async () => {
    mockWithAuth.mockResolvedValue({ user: null });

    await expect(requireUser("/aviation")).rejects.toThrow(
      "NEXT_REDIRECT:/auth/signin?returnTo=%2Faviation",
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      "/auth/signin?returnTo=%2Faviation",
    );
  });

  it("preserves query strings in the returnTo path (encoded)", async () => {
    mockWithAuth.mockResolvedValue({ user: null });

    await expect(requireUser("/history?days=30")).rejects.toThrow(
      "NEXT_REDIRECT:/auth/signin?returnTo=%2Fhistory%3Fdays%3D30",
    );
  });

  it("falls back to bare /auth/signin when no returnTo is given", async () => {
    mockWithAuth.mockResolvedValue({ user: null });

    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
    expect(mockRedirect).toHaveBeenCalledWith("/auth/signin");
  });
});
