/**
 * Developer API key tests (platform.apiKeys).
 *
 * Covers the security-critical invariants:
 *   - key generation format + entropy
 *   - hashing is deterministic and NEVER equals / stores the raw key
 *   - masking never leaks the secret
 *   - label sanitisation
 *   - platform.apiKeys schema shape (keyType/surfaceContext/scopes/hash, no bundu)
 *   - ownerPersonId resolution from the WorkOS user
 *   - owner-scoped list / count / soft-delete revoke against an in-memory fake
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory store standing in for `platform.apiKeys`.
interface Row {
  _id: string;
  [k: string]: unknown;
}
const store: Row[] = [];

function matches(row: Row, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => row[k] === v);
}

function makeApiKeysCollection() {
  return {
    countDocuments: async (q: Record<string, unknown>) =>
      store.filter((r) => matches(r, q)).length,
    find: (q: Record<string, unknown>) => ({
      sort: () => ({
        toArray: async () =>
          store
            .filter((r) => matches(r, q))
            .slice()
            .sort(
              (a, b) =>
                new Date(b.createdAt as string).getTime() -
                new Date(a.createdAt as string).getTime(),
            ),
      }),
    }),
    insertOne: async (doc: Row) => {
      store.push(doc);
      return { insertedId: doc._id };
    },
    updateOne: async (
      q: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ) => {
      const row = store.find((r) => matches(r, q));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, update.$set);
      return { modifiedCount: 1 };
    },
  };
}

// persons lookup + entity memberships are controllable per-test.
const personsFindOne = vi.fn();
const upsertPlatformPerson = vi.fn();
let membershipRows: Array<{ entityId: string }> = [];

vi.mock("./db", () => ({
  platformApiKeysCollection: () => makeApiKeysCollection(),
  personsCollection: () => ({ findOne: personsFindOne }),
  entityMembershipsCollection: () => ({
    find: () => ({
      sort: () => ({ toArray: async () => membershipRows }),
    }),
  }),
}));

vi.mock("./auth", () => ({
  upsertPlatformPerson: (...args: unknown[]) => upsertPlatformPerson(...args),
}));

import {
  generateApiKey,
  hashApiKey,
  deriveKeyMeta,
  maskApiKey,
  sanitizeLabel,
  toPublic,
  createDeveloperApiKey,
  listDeveloperApiKeys,
  countDeveloperApiKeys,
  revokeDeveloperApiKey,
  resolveOwnerPersonId,
  resolveOwnerEntityId,
  KEY_PREFIX,
  MAX_KEYS_PER_USER,
  MAX_LABEL_LENGTH,
  type PlatformApiKeyDoc,
} from "./api-keys";

beforeEach(() => {
  store.length = 0;
  membershipRows = [];
  personsFindOne.mockReset();
  upsertPlatformPerson.mockReset();
});

describe("generateApiKey", () => {
  it("starts with the live prefix and has 64 hex chars of entropy", () => {
    const key = generateApiKey();
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(key.slice(KEY_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces unique keys", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey()));
    expect(keys.size).toBe(200);
  });
});

describe("hashApiKey", () => {
  it("is a 64-char hex sha256 digest", () => {
    expect(hashApiKey("mk_live_abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (platform O(1) lookup hash)", () => {
    const k = generateApiKey();
    expect(hashApiKey(k)).toBe(hashApiKey(k));
  });

  it("never equals the raw key", () => {
    const k = generateApiKey();
    expect(hashApiKey(k)).not.toBe(k);
  });

  it("differs for different keys", () => {
    expect(hashApiKey(generateApiKey())).not.toBe(hashApiKey(generateApiKey()));
  });
});

describe("deriveKeyMeta + maskApiKey", () => {
  it("derives a prefix and last-4 that never expose the full secret", () => {
    const key = generateApiKey();
    const { keyPrefix, keyLast4 } = deriveKeyMeta(key);
    const random = key.slice(KEY_PREFIX.length);
    expect(keyPrefix).toBe(KEY_PREFIX + random.slice(0, 4));
    expect(keyLast4).toBe(random.slice(-4));
    const masked = maskApiKey(keyPrefix, keyLast4);
    expect(masked).toBe(`${keyPrefix}…${keyLast4}`);
    expect(masked.length).toBeLessThan(key.length);
    expect(key).not.toContain(masked);
  });
});

describe("sanitizeLabel", () => {
  it("trims and collapses internal whitespace", () => {
    expect(sanitizeLabel("  my   key  ")).toBe("my key");
  });

  it("strips control characters", () => {
    expect(sanitizeLabel("a\u0000b\u0001c")).toBe("a b c");
  });

  it("caps at the max length", () => {
    expect(sanitizeLabel("x".repeat(200)).length).toBe(MAX_LABEL_LENGTH);
  });

  it("returns empty string for non-strings and blank input", () => {
    expect(sanitizeLabel(undefined)).toBe("");
    expect(sanitizeLabel(123)).toBe("");
    expect(sanitizeLabel("   ")).toBe("");
    expect(sanitizeLabel({})).toBe("");
  });
});

describe("toPublic", () => {
  it("masks the key, maps name→label, and never leaks the hash", () => {
    const doc = {
      _id: "id-1",
      name: "site",
      keyHashedSecret: "deadbeef",
      keyPrefix: "mk_live_ab12",
      keyLast4: "ef90",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastUsedAt: null,
    } as unknown as PlatformApiKeyDoc;
    const pub = toPublic(doc);
    expect(pub).toEqual({
      id: "id-1",
      label: "site",
      maskedKey: "mk_live_ab12…ef90",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });
    expect(JSON.stringify(pub)).not.toContain("deadbeef");
    expect(JSON.stringify(pub)).not.toContain("keyHashedSecret");
  });
});

describe("resolveOwnerPersonId", () => {
  const user = { id: "workos_1", email: "dev@example.com" };

  it("returns the existing identity.persons._id when the person exists", async () => {
    personsFindOne.mockResolvedValueOnce({ _id: "person-abc" });
    expect(await resolveOwnerPersonId(user)).toBe("person-abc");
    expect(upsertPlatformPerson).not.toHaveBeenCalled();
  });

  it("creates the person when missing and returns the new _id", async () => {
    personsFindOne.mockResolvedValueOnce(null);
    upsertPlatformPerson.mockResolvedValueOnce({
      person: { _id: "person-new" },
      created: true,
    });
    expect(await resolveOwnerPersonId(user)).toBe("person-new");
    expect(upsertPlatformPerson).toHaveBeenCalledWith(user);
  });
});

describe("resolveOwnerEntityId", () => {
  it("returns null when the person has no eligible membership", async () => {
    membershipRows = [];
    expect(await resolveOwnerEntityId("person-1")).toBeNull();
  });

  it("returns the single entity when the person has one eligible membership", async () => {
    membershipRows = [{ entityId: "ent-1" }];
    expect(await resolveOwnerEntityId("person-1")).toEqual({
      entityId: "ent-1",
      entityIds: ["ent-1"],
    });
  });

  it("returns the first (oldest) entity as primary plus the full list", async () => {
    membershipRows = [{ entityId: "ent-1" }, { entityId: "ent-2" }];
    expect(await resolveOwnerEntityId("person-1")).toEqual({
      entityId: "ent-1",
      entityIds: ["ent-1", "ent-2"],
    });
  });
});

describe("createDeveloperApiKey (platform.apiKeys schema, never stores raw)", () => {
  it("persists a validator-shaped doc with only the hash + no bundu", async () => {
    const { fullKey, key } = await createDeveloperApiKey(
      "person-1",
      "site",
      "ent-xyz",
    );
    expect(fullKey.startsWith(KEY_PREFIX)).toBe(true);

    expect(store).toHaveLength(1);
    const stored = store[0] as unknown as PlatformApiKeyDoc & {
      bundu?: unknown;
    };

    // Raw key must NOT appear anywhere in the stored document.
    expect(JSON.stringify(stored)).not.toContain(fullKey);
    // Only the SHA-256 hash of the raw key is stored.
    expect(stored.keyHashedSecret).toBe(hashApiKey(fullKey));

    // Platform schema shape.
    expect(stored._schemaVersion).toBe("v3.1");
    expect(stored.keyType).toBe("external");
    expect(stored.surfaceContext).toBe("mukoko-weather");
    expect(stored.scopes).toEqual(["weather:read"]);
    expect(stored.planTier).toBe("free");
    expect(stored.ownerEntityId).toBe("ent-xyz");
    expect(stored.ownerPersonId).toBe("person-1");
    expect(stored.createdByPersonId).toBe("person-1");
    expect(stored.name).toBe("site");
    expect(stored.isActive).toBe(true);
    expect(stored.monthlyRequestCount).toBe(0);
    expect(stored.monthlyRequestLimit).toBeNull();
    expect(stored.revokedAt).toBeNull();
    expect(stored.createdAt).toBeInstanceOf(Date);
    // platform.apiKeys has NO bundu field — must not be stamped.
    expect(stored.bundu).toBeUndefined();

    // Masked public record matches the derived meta.
    const { keyPrefix, keyLast4 } = deriveKeyMeta(fullKey);
    expect(key.maskedKey).toBe(maskApiKey(keyPrefix, keyLast4));
  });
});

describe("owner-scoped list / count / soft-delete revoke", () => {
  it("only returns and counts a user's own active keys, newest first", async () => {
    await createDeveloperApiKey("u1", "first", "ent-1");
    await new Promise((r) => setTimeout(r, 5));
    await createDeveloperApiKey("u1", "second", "ent-1");
    await createDeveloperApiKey("u2", "other-user", "ent-2");

    expect(await countDeveloperApiKeys("u1")).toBe(2);
    expect(await countDeveloperApiKeys("u2")).toBe(1);

    const u1 = await listDeveloperApiKeys("u1");
    expect(u1.map((k) => k.label)).toEqual(["second", "first"]);
    expect(u1.some((k) => k.label === "other-user")).toBe(false);
  });

  it("soft-deletes only the owner's key and ignores foreign ids", async () => {
    const { key } = await createDeveloperApiKey("u1", "mine", "ent-1");

    // Wrong owner cannot revoke.
    expect(await revokeDeveloperApiKey("u2", key.id)).toBe(false);
    expect(await countDeveloperApiKeys("u1")).toBe(1);

    // Correct owner can — soft-delete flips isActive + stamps revokedAt.
    expect(await revokeDeveloperApiKey("u1", key.id)).toBe(true);
    const stored = store[0] as unknown as PlatformApiKeyDoc;
    expect(stored.isActive).toBe(false);
    expect(stored.revokedAt).toBeInstanceOf(Date);

    // Revoked key drops out of list + count, and re-revoke is a no-op.
    expect(await countDeveloperApiKeys("u1")).toBe(0);
    expect(await listDeveloperApiKeys("u1")).toHaveLength(0);
    expect(await revokeDeveloperApiKey("u1", key.id)).toBe(false);
  });
});

describe("constants", () => {
  it("caps keys per user at 10", () => {
    expect(MAX_KEYS_PER_USER).toBe(10);
  });
});
