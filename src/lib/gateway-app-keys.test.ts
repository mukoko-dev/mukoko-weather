/**
 * /v1/app-keys client + gateway transport/config (nyuchi/api-gateway#307).
 * No network: transports are stubs.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AppKeysError,
  createAppKeysClient,
  maskAppKey,
} from "./gateway-app-keys";
import {
  fetchTransport,
  gatewayConfig,
  gatewayCredentials,
  gatewayOrigin,
  gatewayRequest,
  serviceBindingTransport,
  type GatewayConfig,
} from "./nyuchi-gateway";

const SECRET = "nys_supersecretvalue123";
const PERSON = "person.jwt.token";

function client(handler: (req: Request) => Response | Promise<Response>) {
  const transport = vi.fn(async (req: Request) => handler(req));
  const cfg: GatewayConfig = {
    transport,
    credentials: { clientId: "nyk_weatherkey01", clientSecret: SECRET },
  };
  return { api: createAppKeysClient(() => cfg), transport };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe("gateway config (server env, fail closed)", () => {
  it("accepts only a bare https origin (http for localhost)", () => {
    expect(gatewayOrigin({ NYUCHI_API_URL: "https://api.nyuchi.com" })).toBe(
      "https://api.nyuchi.com",
    );
    expect(gatewayOrigin({ NYUCHI_API_URL: "http://localhost:8000" })).toBe(
      "http://localhost:8000",
    );
    for (const bad of [
      "",
      "http://api.nyuchi.com",
      "https://u:p@api.nyuchi.com",
      "https://api.nyuchi.com/v1",
      "https://api.nyuchi.com/?x=1",
      "not a url",
    ]) {
      expect(gatewayOrigin({ NYUCHI_API_URL: bad })).toBeNull();
    }
  });

  it("splits nyk_.nys_ and rejects anything else", () => {
    expect(
      gatewayCredentials({
        NYUCHI_APP_KEYS_API_KEY: `nyk_weatherkey01.${SECRET}`,
      }),
    ).toEqual({ clientId: "nyk_weatherkey01", clientSecret: SECRET });
    expect(gatewayCredentials({ NYUCHI_APP_KEYS_API_KEY: SECRET })).toBeNull();
    expect(gatewayCredentials({})).toBeNull();
  });

  it("is null unless both URL and key are set", () => {
    expect(gatewayConfig({ NYUCHI_API_URL: "https://api.nyuchi.com" })).toBe(
      null,
    );
    expect(
      gatewayConfig({ NYUCHI_APP_KEYS_API_KEY: `nyk_weatherkey01.${SECRET}` }),
    ).toBeNull();
  });

  it("fetch transport targets the origin, follows no redirect, no cache", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const t = fetchTransport(
      "https://api.nyuchi.com",
      fetchImpl as unknown as typeof fetch,
    );
    await t(gatewayRequest("/v1/app-keys?app=weather", { method: "GET" }));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(String(url)).toBe("https://api.nyuchi.com/v1/app-keys?app=weather");
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBeUndefined();
  });

  it("a service binding plugs into the same interface", async () => {
    const binding = { fetch: vi.fn(async () => new Response("ok")) };
    const t = serviceBindingTransport(binding);
    const req = gatewayRequest("/v1/auth/token", { method: "POST", body: "a" });
    await t(req);
    expect(binding.fetch).toHaveBeenCalledWith(req);
  });
});

describe("app-keys calls carry the app key AND the person's own token", () => {
  it("list: GET with both credentials, masked output only", async () => {
    const { api, transport } = client(() =>
      json(200, {
        keys: [
          {
            _id: "k1",
            name: "site",
            keyPrefix: "nyk_ab12",
            planTier: "free",
            readOnly: true,
            isActive: true,
            keyHashedSecret: "HASH",
            clientSecret: "nys_leak",
            ownerEntityId: "fam_1",
            createdAt: "2026-10-01T00:00:00Z",
          },
        ],
      }),
    );
    const keys = await api.list(PERSON);
    const req = transport.mock.calls[0][0];
    expect(req.method).toBe("GET");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/v1/app-keys");
    expect(url.searchParams.get("app")).toBe("weather");
    expect(url.searchParams.has("personId")).toBe(false);
    expect(req.headers.get("authorization")).toBe(`Bearer ${PERSON}`);
    expect(req.headers.get("x-client-id")).toBe("nyk_weatherkey01");
    expect(req.headers.get("x-client-secret")).toBe(SECRET);
    expect(keys).toHaveLength(1);
    const text = JSON.stringify(keys);
    expect(text).not.toContain("HASH");
    expect(text).not.toContain("nys_leak");
    expect(text).not.toContain("fam_1");
    expect(keys[0]).toMatchObject({ id: "k1", keyPrefix: "nyk_ab12" });
  });

  it("create: POSTs {app: weather, name} and returns the key once", async () => {
    const { api, transport } = client(() =>
      json(201, {
        id: "k2",
        clientId: "nyk_k2",
        clientSecret: "nys_secret",
        apiKey: "nyk_k2.nys_secret",
        name: "site",
        planTier: "free",
        readOnly: true,
        ownerEntityId: "fam_1",
      }),
    );
    const key = await api.create(PERSON, "site");
    const req = transport.mock.calls[0][0];
    expect(req.method).toBe("POST");
    expect(JSON.parse(await req.text())).toEqual({
      app: "weather",
      name: "site",
    });
    expect(key.apiKey).toBe("nyk_k2.nys_secret");
    expect(key.keyPrefix).toBe("nyk_k2");
    expect(JSON.stringify(key)).not.toContain("fam_1");
  });

  it("revoke: DELETE by id, never a personId", async () => {
    const { api, transport } = client(() => json(200, { revoked: true }));
    await api.revoke(PERSON, "k_1");
    const req = transport.mock.calls[0][0];
    expect(req.method).toBe("DELETE");
    expect(new URL(req.url).pathname).toBe("/v1/app-keys/k_1");
    await expect(api.revoke(PERSON, "../x")).rejects.toMatchObject({
      code: "invalid_id",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("app-keys error mapping", () => {
  const cases: [number, string, number, string][] = [
    [401, "person_token_required", 503, "person_token_rejected"],
    [401, "invalid_token", 503, "person_token_rejected"],
    [403, "account_pending_deletion", 403, "account_pending_deletion"],
    [404, "person_not_found", 409, "person_not_provisioned"],
    [403, "person_mismatch", 503, "gateway_unconfigured"],
    [403, "app_not_on_free_tier", 403, "app_not_on_free_tier"],
    [409, "key_limit_reached", 409, "key_limit_reached"],
    [409, "free_tier_key_limit", 409, "free_tier_key_limit"],
    [404, "key_not_found", 404, "key_not_found"],
    [422, "invalid", 400, "invalid_request"],
    [429, "slow_down", 429, "rate_limited"],
    [503, "plan_tier_not_accepted", 503, "plan_tier_not_accepted"],
    [500, "boom", 503, "gateway_unavailable"],
    [302, "redirect", 503, "gateway_unavailable"],
  ];
  for (const [status, error, wantStatus, wantCode] of cases) {
    it(`${status} ${error} → ${wantStatus} ${wantCode}`, async () => {
      const { api } = client(() =>
        json(status, { detail: { error, error_description: "x" } }),
      );
      const err = await api.list(PERSON).catch((e) => e);
      expect(err).toBeInstanceOf(AppKeysError);
      expect(err.status).toBe(wantStatus);
      expect(err.code).toBe(wantCode);
    });
  }

  it("caps Retry-After to a whole number of seconds ≤ 3600", async () => {
    for (const [raw, want] of [
      ["7", 7],
      ["99999", 3600],
      ["Infinity", undefined],
      ["1.5", undefined],
      ["-3", undefined],
      ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
    ] as const) {
      const { api } = client(
        () =>
          new Response("{}", { status: 429, headers: { "retry-after": raw } }),
      );
      const err = await api.list(PERSON).catch((e) => e);
      expect(err.code).toBe("rate_limited");
      expect(err.retryAfterSeconds).toBe(want);
    }
  });

  it("a transport failure or bad body fails closed", async () => {
    const { api } = client(() => {
      throw new Error("down");
    });
    await expect(api.list(PERSON)).rejects.toMatchObject({ status: 503 });
    const bad = client(() => new Response("not json", { status: 200 }));
    await expect(bad.api.list(PERSON)).rejects.toMatchObject({ status: 503 });
  });

  it("unconfigured gateway is 503 without a call", async () => {
    const api = createAppKeysClient(() => null);
    await expect(api.list(PERSON)).rejects.toMatchObject({
      status: 503,
      code: "gateway_unconfigured",
    });
  });

  it("maskAppKey keeps only allowlisted fields", () => {
    const masked = maskAppKey({ _id: "a", secretHash: "h", name: 3 });
    expect(Object.keys(masked)).not.toContain("secretHash");
    expect(masked.name).toBeNull();
  });
});
