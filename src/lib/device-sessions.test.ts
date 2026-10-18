import { describe, it, expect, vi } from "vitest";
import {
  isSessionId,
  listSignedInDevices,
  signOutDevice,
  toSignedInDevices,
  type SessionsApi,
  type WorkosSession,
} from "./device-sessions";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function session(over: Partial<WorkosSession> & { id: string }): WorkosSession {
  return {
    userId: "user_me",
    userAgent: MAC,
    status: "active",
    expiresAt: "2026-11-17T12:00:00Z",
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-16T12:00:00Z",
    ...over,
  };
}

function fakeApi(sessions: WorkosSession[]): SessionsApi & {
  revoke: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  return {
    list: vi.fn(async (userId: string) =>
      sessions.filter((s) => s.userId === userId),
    ),
    revoke: vi.fn(async () => undefined),
  };
}

describe("toSignedInDevices", () => {
  it("lists only active, unexpired sessions", () => {
    const out = toSignedInDevices(
      [
        session({ id: "a" }),
        session({ id: "b", status: "revoked" }),
        session({ id: "c", status: "expired" }),
        session({ id: "d", expiresAt: "2026-10-01T00:00:00Z" }),
      ],
      undefined,
      NOW,
    );
    expect(out.map((d) => d.id)).toEqual(["a"]);
  });

  it("puts this device first, then newest first, and marks only it current", () => {
    const out = toSignedInDevices(
      [
        session({ id: "old", updatedAt: "2026-10-01T00:00:00Z" }),
        session({ id: "new", updatedAt: "2026-10-16T00:00:00Z" }),
        session({ id: "me", updatedAt: "2026-09-01T00:00:00Z" }),
      ],
      "me",
      NOW,
    );
    expect(out.map((d) => d.id)).toEqual(["me", "new", "old"]);
    expect(out.map((d) => d.current)).toEqual([true, false, false]);
  });

  it("describes a device coarsely and never exposes an IP or the raw user agent", () => {
    const withIp = {
      ...session({ id: "a", userAgent: IPHONE }),
      ipAddress: "203.0.113.9",
    } as WorkosSession;
    const [d] = toSignedInDevices([withIp], undefined, NOW);
    expect(d).toMatchObject({
      label: "Safari on iOS",
      os: "iOS",
      browser: "Safari",
      formFactor: "phone",
    });
    const json = JSON.stringify(d);
    expect(json).not.toContain("203.0.113.9");
    expect(json).not.toContain("Mozilla");
    expect(Object.keys(d).sort()).toEqual([
      "browser",
      "current",
      "formFactor",
      "id",
      "label",
      "lastActiveAt",
      "os",
      "signedInAt",
    ]);
  });

  it("drops a session whose id is not a plain handle", () => {
    expect(
      toSignedInDevices([session({ id: "../x" })], undefined, NOW),
    ).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 80 }, (_, i) => session({ id: `s${i}` }));
    expect(toSignedInDevices(many, undefined, NOW).length).toBe(50);
  });
});

describe("listSignedInDevices — own devices only", () => {
  it("asks WorkOS for the caller's user id, nothing else", async () => {
    const api = fakeApi([
      session({ id: "mine" }),
      session({ id: "theirs", userId: "user_other" }),
    ]);
    const out = await listSignedInDevices(api, "user_me", "mine", NOW);
    expect(api.list).toHaveBeenCalledWith("user_me");
    expect(out.map((d) => d.id)).toEqual(["mine"]);
  });
});

describe("signOutDevice", () => {
  it("ends a session found in the caller's own active list", async () => {
    const api = fakeApi([session({ id: "other" })]);
    expect(await signOutDevice(api, "user_me", "other", NOW)).toBe("ended");
    expect(api.revoke).toHaveBeenCalledWith("other");
  });

  it("never reaches WorkOS for another person's session id", async () => {
    const api = fakeApi([session({ id: "theirs", userId: "user_other" })]);
    expect(await signOutDevice(api, "user_me", "theirs", NOW)).toBe(
      "not_found",
    );
    expect(api.revoke).not.toHaveBeenCalled();
  });

  it("never reaches WorkOS for a stale (already ended) session or a malformed id", async () => {
    const api = fakeApi([session({ id: "gone", status: "revoked" })]);
    expect(await signOutDevice(api, "user_me", "gone", NOW)).toBe("not_found");
    expect(await signOutDevice(api, "user_me", "a/../b", NOW)).toBe(
      "not_found",
    );
    expect(api.revoke).not.toHaveBeenCalled();
  });
});

describe("isSessionId", () => {
  it("accepts WorkOS ids and refuses path-like or long input", () => {
    expect(isSessionId("session_01ABC-def_9")).toBe(true);
    expect(isSessionId("")).toBe(false);
    expect(isSessionId("a b")).toBe(false);
    expect(isSessionId("x".repeat(65))).toBe(false);
    expect(isSessionId(42)).toBe(false);
  });
});
