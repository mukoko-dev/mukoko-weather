/**
 * /api/devices: signed-in only, the caller's own devices only, same-origin
 * JSON for anything that changes state, per-user limits, and a plain 503
 * (nothing sent, nothing stored) while the platform cannot take a device.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const withAuthMock = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: withAuthMock }));

const rateLimitMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-rate-limit", () => ({ checkUserRateLimit: rateLimitMock }));

vi.mock("@/lib/observability", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const apiList = vi.hoisted(() => vi.fn());
const apiRevoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/device-sessions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/device-sessions")>(
    "@/lib/device-sessions",
  );
  return {
    ...actual,
    workosSessionsApi: async () => ({ list: apiList, revoke: apiRevoke }),
  };
});

import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

const SITE = "https://weather.mukoko.com";
const JSON_ORIGIN = { "content-type": "application/json", origin: SITE };
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

const wk = (id: string, userId = "user_1", extra = {}) => ({
  id,
  userId,
  userAgent: MAC,
  status: "active" as const,
  expiresAt: future,
  createdAt: past,
  updatedAt: past,
  ...extra,
});

const REG = {
  deviceId: "11111111-2222-4333-8444-555555555555",
  name: "Safari on iOS",
  platform: "web_safari",
  formFactor: "phone",
  standalone: true,
  permissions: { geolocation: { state: "granted", changedAt: 5 } },
  preferences: { theme: "dark", savedLocations: ["harare"] },
};

const post = (body: unknown, headers: Record<string, string> = JSON_ORIGIN) =>
  new Request(`${SITE}/api/devices`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as never;
const del = (id: string, headers: Record<string, string> = JSON_ORIGIN) =>
  new Request(`${SITE}/api/devices/${id}`, {
    method: "DELETE",
    headers,
  }) as never;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const m of [withAuthMock, rateLimitMock, apiList, apiRevoke])
    m.mockReset();
  rateLimitMock.mockResolvedValue({ allowed: true });
  withAuthMock.mockResolvedValue({ user: { id: "user_1" }, sessionId: "me" });
  apiList.mockImplementation(async (userId: string) =>
    [wk("me"), wk("other"), wk("theirs", "user_2")].filter(
      (s) => s.userId === userId,
    ),
  );
});

describe("GET /api/devices", () => {
  it("is 401 for an anonymous caller and never reaches WorkOS", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(apiList).not.toHaveBeenCalled();
  });

  it("treats a path AuthKit skipped (withAuth throws) as signed out", async () => {
    withAuthMock.mockRejectedValue(new Error("no middleware"));
    expect((await GET()).status).toBe(401);
  });

  it("lists only the caller's own devices, marks this one, no-store", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(apiList).toHaveBeenCalledWith("user_1");
    const body = await res.json();
    expect(body.devices.map((d: { id: string }) => d.id)).toEqual([
      "me",
      "other",
    ]);
    expect(body.devices[0].current).toBe(true);
    expect(body.devices[1].current).toBe(false);
    expect(JSON.stringify(body)).not.toContain("user_2");
    expect(JSON.stringify(body)).not.toContain("Mozilla");
  });

  it("is 429 over the per-user limit, keyed by user and action", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(rateLimitMock).toHaveBeenCalledWith(
      "devices-list",
      "user_1",
      30,
      60,
    );
  });

  it("is a plain 503 when WorkOS fails, without the error text", async () => {
    apiList.mockRejectedValue(new Error("secret upstream detail"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});

describe("POST /api/devices (register)", () => {
  it("refuses cross-site and non-JSON requests first", async () => {
    expect(
      (
        await POST(
          post(REG, {
            "content-type": "application/json",
            origin: "https://evil.example",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await POST(post(REG, { "content-type": "text/plain", origin: SITE })))
        .status,
    ).toBe(415);
    expect(
      (await POST(post(REG, { "content-type": "application/json" }))).status,
    ).toBe(403);
  });

  it("validates the body before the sign-in gate or the limiter", async () => {
    const res = await POST(post({ deviceId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(withAuthMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("is 401 when anonymous", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    expect((await POST(post(REG))).status).toBe(401);
  });

  it("answers 503 devices_unavailable in production and sends nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(post(REG));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("devices_unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is limited per user", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    expect((await POST(post(REG))).status).toBe(429);
    expect(rateLimitMock).toHaveBeenCalledWith(
      "devices-register",
      "user_1",
      20,
      3600,
    );
  });
});

describe("DELETE /api/devices/[id] (sign a device out)", () => {
  it("refuses cross-site requests", async () => {
    const res = await DELETE(
      del("other", {
        "content-type": "application/json",
        origin: "https://evil.example",
      }),
      ctx("other"),
    );
    expect(res.status).toBe(403);
    expect(apiRevoke).not.toHaveBeenCalled();
  });

  it("rejects a malformed id before the gate", async () => {
    const res = await DELETE(del("a b"), ctx("a b"));
    expect(res.status).toBe(400);
    expect(withAuthMock).not.toHaveBeenCalled();
  });

  it("is 401 when anonymous", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    expect((await DELETE(del("other"), ctx("other"))).status).toBe(401);
    expect(apiRevoke).not.toHaveBeenCalled();
  });

  it("ends another of the caller's own sessions", async () => {
    const res = await DELETE(del("other"), ctx("other"));
    expect(res.status).toBe(200);
    expect(apiRevoke).toHaveBeenCalledWith("other");
  });

  it("will not end someone else's session: 404, WorkOS never asked to revoke", async () => {
    const res = await DELETE(del("theirs"), ctx("theirs"));
    expect(res.status).toBe(404);
    expect(apiRevoke).not.toHaveBeenCalled();
  });

  it("sends the current device to Sign out instead (409)", async () => {
    const res = await DELETE(del("me"), ctx("me"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("current_device");
    expect(apiRevoke).not.toHaveBeenCalled();
  });

  it("is limited per user", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    expect((await DELETE(del("other"), ctx("other"))).status).toBe(429);
    expect(rateLimitMock).toHaveBeenCalledWith(
      "devices-signout",
      "user_1",
      20,
      3600,
    );
  });
});
