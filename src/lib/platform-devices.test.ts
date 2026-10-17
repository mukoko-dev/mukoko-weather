import { describe, it, expect, vi } from "vitest";
import {
  NYUCHI_API_ORIGIN,
  PLATFORM_DEVICES_READY,
  createPlatformDevicesClient,
  registerWithPlatform,
  sanitizeRegistration,
  DevicesError,
} from "./platform-devices";
import type { GatewayTransport } from "./nyuchi-gateway";

const ID = "11111111-2222-4333-8444-555555555555";

describe("gateway origin", () => {
  it("is api.nyuchi.com", () => {
    expect(NYUCHI_API_ORIGIN).toBe("https://api.nyuchi.com");
  });
});

describe("PLATFORM_DEVICES_READY", () => {
  it("stays false until the gateway serves the routes (asks 1 to 5 of #320)", () => {
    expect(PLATFORM_DEVICES_READY).toBe(false);
  });
});

describe("sanitizeRegistration", () => {
  it("refuses a body with no valid device id", () => {
    expect(sanitizeRegistration(null)).toBeNull();
    expect(sanitizeRegistration({})).toBeNull();
    expect(sanitizeRegistration({ deviceId: "abc" })).toBeNull();
  });

  it("keeps only allowlisted fields and drops everything else", () => {
    const out = sanitizeRegistration({
      deviceId: ID.toUpperCase(),
      name: "  My\u0000 phone  ",
      platform: "web_safari",
      formFactor: "phone",
      standalone: true,
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      lat: -17.8,
      lon: 31.05,
      sessionId: "forged",
      permissions: {
        geolocation: { state: "granted", changedAt: 5, lat: 1 },
        notifications: { state: "bogus", changedAt: 5 },
      },
      preferences: { theme: "dark", presetAnchor: { lat: 1, lon: 2 } },
    });
    expect(out).toEqual({
      deviceId: ID,
      name: "My phone",
      platform: "web_safari",
      formFactor: "phone",
      standalone: true,
      permissions: {
        geolocation: { state: "granted", changedAt: 5 },
        notifications: null,
      },
      preferences: {
        theme: "dark",
        selectedActivities: [],
        savedLocations: [],
        forecastModel: "best_match",
        homeLocation: null,
      },
    });
    const json = JSON.stringify(out);
    for (const leaked of [
      "203.0.113.9",
      "Mozilla",
      "-17.8",
      "31.05",
      "forged",
      "presetAnchor",
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("coarsens a spot's geohash so no precise coordinate is sent", () => {
    const out = sanitizeRegistration({
      deviceId: ID,
      preferences: {
        savedLocations: ["harare", "west-paddock--ksy4dd7"],
        homeLocation: "west-paddock--ksy4dd7",
      },
    });
    expect(out?.preferences.savedLocations).toEqual(["harare", "spot--ksy4"]);
    expect(out?.preferences.homeLocation).toBe("spot--ksy4");
  });

  it("bounds arrays and rejects malformed ids and slugs", () => {
    const out = sanitizeRegistration({
      deviceId: ID,
      preferences: {
        selectedActivities: [
          ...Array.from({ length: 50 }, (_, i) => `act-${i}`),
          "Bad Id!",
        ],
        savedLocations: [
          ...Array.from({ length: 30 }, (_, i) => `place-${i}`),
          "../etc",
        ],
        forecastModel: "ecmwf ifs",
      },
    });
    expect(out?.preferences.selectedActivities).toHaveLength(30);
    expect(out?.preferences.savedLocations).toHaveLength(10);
    expect(out?.preferences.forecastModel).toBe("best_match");
  });

  it("falls back to safe defaults for unknown platform, form factor and empty name", () => {
    const out = sanitizeRegistration({
      deviceId: ID,
      name: "   ",
      platform: "toaster",
      formFactor: "fridge",
    });
    expect(out).toMatchObject({
      name: "This device",
      platform: "web_other",
      formFactor: "desktop",
      standalone: false,
    });
  });
});

function fakeConfig(respond: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const config: GatewayTransport = async (req) => {
    calls.push(req);
    return respond(req);
  };
  return { config, calls };
}

const REG = sanitizeRegistration({ deviceId: ID, platform: "web_safari" })!;

describe("platform client (against a fake transport)", () => {
  it("PUTs the registration with the person token and the session id", async () => {
    const { config, calls } = fakeConfig(
      () => new Response(null, { status: 204 }),
    );
    await createPlatformDevicesClient(() => config).register(
      "person.token",
      REG,
      "sess_1",
    );
    const [req] = calls;
    expect(req.method).toBe("PUT");
    expect(new URL(req.url).pathname).toBe(`/v1/devices/mine/${ID}`);
    expect(req.headers.get("authorization")).toBe("Bearer person.token");
    // No API key or secret: the person's token is the only credential.
    expect([...req.headers.keys()].some((h) => h.startsWith("x-client"))).toBe(
      false,
    );
    const body = await req.json();
    expect(body.sessionId).toBe("sess_1");
    expect(body.deviceId).toBe(ID);
  });

  it("maps a missing route, a failure and a thrown transport to devices_unavailable", async () => {
    for (const status of [404, 405, 500]) {
      const { config } = fakeConfig(() => new Response(null, { status }));
      await expect(
        createPlatformDevicesClient(() => config).register("t", REG, undefined),
      ).rejects.toMatchObject({ status: 503, code: "devices_unavailable" });
    }
    const boom: GatewayTransport = async () => {
      throw new Error("down");
    };
    await expect(
      createPlatformDevicesClient(() => boom).register("t", REG, undefined),
    ).rejects.toMatchObject({ code: "devices_unavailable" });
    await expect(
      createPlatformDevicesClient(() => null).register("t", REG, undefined),
    ).rejects.toMatchObject({ code: "devices_unavailable" });
  });

  it("passes a 429 through with its Retry-After", async () => {
    const { config } = fakeConfig(
      () =>
        new Response(null, { status: 429, headers: { "retry-after": "30" } }),
    );
    await expect(
      createPlatformDevicesClient(() => config).register("t", REG, undefined),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 30 });
  });
});

describe("registerWithPlatform", () => {
  it("does not exchange a token or call the client while the platform is not ready", async () => {
    const token = vi.fn(async () => "t");
    const register = vi.fn(async () => undefined);
    await expect(
      registerWithPlatform(REG, "s", {
        ready: false,
        token,
        client: { register },
      }),
    ).rejects.toBeInstanceOf(DevicesError);
    expect(token).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("registers with the caller's own token once ready", async () => {
    const register = vi.fn(async () => undefined);
    await registerWithPlatform(REG, "s", {
      ready: true,
      token: async () => "person.token",
      client: { register },
    });
    expect(register).toHaveBeenCalledWith("person.token", REG, "s");
  });
});
