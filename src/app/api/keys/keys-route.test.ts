/**
 * /api/keys route tests (list + create).
 *
 * Verifies the gate (401 when anon), owner-scoping (the WorkOS user is resolved
 * to their `identity.persons._id` and every DB call is scoped to it), label
 * validation (400), the per-user cap (429), and the one-time full-key reveal on
 * create (201).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const withAuthMock = vi.fn();
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: withAuthMock }));

// Mock the DB layer but keep the real sanitiser + cap constant.
const listMock = vi.fn();
const createMock = vi.fn();
const countMock = vi.fn();
const resolveMock = vi.fn();
const entityMock = vi.fn();
vi.mock("@/lib/api-keys", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-keys")>("@/lib/api-keys");
  return {
    ...actual,
    listDeveloperApiKeys: listMock,
    createDeveloperApiKey: createMock,
    countDeveloperApiKeys: countMock,
    resolveOwnerPersonId: resolveMock,
    resolveOwnerEntityId: entityMock,
  };
});

beforeEach(() => {
  withAuthMock.mockReset();
  listMock.mockReset();
  createMock.mockReset();
  countMock.mockReset();
  resolveMock.mockReset();
  entityMock.mockReset();
  // Default: WorkOS user_1 → identity person_1, with an eligible entity.
  resolveMock.mockResolvedValue("person_1");
  entityMock.mockResolvedValue({ entityId: "ent_1", entityIds: ["ent_1"] });
});

function jsonRequest(body: unknown): Request {
  return new Request("https://weather.mukoko.com/api/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/keys", () => {
  it("returns 401 for anonymous users and never touches the DB", async () => {
    withAuthMock.mockResolvedValueOnce({ user: null });
    const mod = await import("./route");
    const res = await mod.GET();
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("lists only the signed-in user's keys", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    listMock.mockResolvedValueOnce([
      { id: "k1", label: "site", maskedKey: "mk_live_ab12…ef90", createdAt: "x", lastUsedAt: null },
    ]);
    const mod = await import("./route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    // Scoped by the resolved identity person id, not the raw WorkOS id.
    expect(listMock).toHaveBeenCalledWith("person_1");
    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.entityRequired).toBe(false);
  });

  it("flags entityRequired when the user has no eligible entity membership", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    listMock.mockResolvedValueOnce([]);
    entityMock.mockResolvedValueOnce(null);
    const mod = await import("./route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entityRequired).toBe(true);
  });
});

describe("POST /api/keys", () => {
  it("returns 401 for anonymous users", async () => {
    withAuthMock.mockResolvedValueOnce({ user: null });
    const mod = await import("./route");
    const res = await mod.POST(jsonRequest({ label: "x" }) as never);
    expect(res.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a blank label with 400", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    const mod = await import("./route");
    const res = await mod.POST(jsonRequest({ label: "   " }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_label");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the user has no eligible entity membership", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    entityMock.mockResolvedValueOnce(null);
    const mod = await import("./route");
    const res = await mod.POST(jsonRequest({ label: "My Site" }) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("entity_required");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("enforces the per-user cap with 429", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    countMock.mockResolvedValueOnce(10);
    const mod = await import("./route");
    const res = await mod.POST(jsonRequest({ label: "another" }) as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("key_limit_reached");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates a key scoped to the user and returns the full key once", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    countMock.mockResolvedValueOnce(2);
    createMock.mockResolvedValueOnce({
      fullKey: "mk_live_deadbeef",
      key: { id: "k9", label: "site", maskedKey: "mk_live_dead…beef", createdAt: "x", lastUsedAt: null },
    });
    const mod = await import("./route");
    const res = await mod.POST(jsonRequest({ label: "  My Site  " }) as never);
    expect(res.status).toBe(201);
    // Label sanitised; key scoped to the resolved person + owned by their entity.
    expect(createMock).toHaveBeenCalledWith("person_1", "My Site", "ent_1");
    const body = await res.json();
    expect(body.fullKey).toBe("mk_live_deadbeef");
    expect(body.key.id).toBe("k9");
  });
});
