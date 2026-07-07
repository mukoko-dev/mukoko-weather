/**
 * DELETE /api/keys/:id tests — owner-scoped revocation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const withAuthMock = vi.fn();
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: withAuthMock }));

const revokeMock = vi.fn();
const resolveMock = vi.fn();
vi.mock("@/lib/api-keys", () => ({
  revokeDeveloperApiKey: revokeMock,
  resolveOwnerPersonId: resolveMock,
}));

beforeEach(() => {
  withAuthMock.mockReset();
  revokeMock.mockReset();
  resolveMock.mockReset();
  // Default: WorkOS user_1 → identity person_1.
  resolveMock.mockResolvedValue("person_1");
});

const VALID_ID = "3f1a2b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b";

function req(): Request {
  return new Request(`https://weather.mukoko.com/api/keys/${VALID_ID}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/keys/:id", () => {
  it("returns 401 for anonymous users and never touches the DB", async () => {
    withAuthMock.mockResolvedValueOnce({ user: null });
    const mod = await import("./route");
    const res = await mod.DELETE(req() as never, {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(401);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed id with 400", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    const mod = await import("./route");
    const res = await mod.DELETE(req() as never, {
      params: Promise.resolve({ id: "not a valid id!!" }),
    });
    expect(res.status).toBe(400);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("revokes scoped to the owner and returns 200", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    revokeMock.mockResolvedValueOnce(true);
    const mod = await import("./route");
    const res = await mod.DELETE(req() as never, {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    // Scoped by the resolved identity person id, not the raw WorkOS id.
    expect(revokeMock).toHaveBeenCalledWith("person_1", VALID_ID);
    const body = await res.json();
    expect(body.revoked).toBe(true);
  });

  it("returns 404 when the key is not the caller's (or does not exist)", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "user_1" } });
    revokeMock.mockResolvedValueOnce(false);
    const mod = await import("./route");
    const res = await mod.DELETE(req() as never, {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(404);
  });
});
