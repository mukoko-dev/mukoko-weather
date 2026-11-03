/**
 * The fake gateway must be as strict as the rules it ports, or the tests that
 * lean on it prove nothing. One test per rule, each against the gateway's own
 * tests in nyuchi-api `tests/test_couch_sync_grant.py` (named where it helps).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  FakeNyuchiGateway,
  fakeJwt,
  workosAccessToken,
} from "./fake-nyuchi-gateway";

const T0 = Date.parse("2026-11-03T09:00:00.000Z");
const CONSOLE = "client_console";
const SYNC = "nyk_sync";
const OTHER = "nyk_other";
const EXTERNAL = "nyk_external";
const NO_IDENTITY = "nyk_noidentity";
let clock = T0;
let gw: FakeNyuchiGateway;

beforeEach(() => {
  clock = T0;
  gw = new FakeNyuchiGateway({
    consoleClientId: CONSOLE,
    keys: {
      [SYNC]: { secret: "nys_s", type: "internal", scopes: ["identity"] },
      [OTHER]: { secret: "nys_o", type: "internal", scopes: ["identity"] },
      [EXTERNAL]: { secret: "nys_e", type: "external", scopes: ["identity"] },
      [NO_IDENTITY]: { secret: "nys_n", type: "internal", scopes: ["weather"] },
    },
    syncClientIds: [SYNC, EXTERNAL, NO_IDENTITY],
    persons: {
      user_a: { id: "person-a" },
      user_gone: { id: "person-gone", deletionScheduled: true },
    },
    now: () => clock,
  });
});

const subject = (over: Partial<Parameters<typeof workosAccessToken>[0]> = {}) =>
  workosAccessToken({
    sub: "user_a",
    clientId: CONSOLE,
    nowMs: clock,
    lifeSeconds: 300,
    ...over,
  });

async function exchange(
  over: Record<string, string | undefined> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new URLSearchParams(
    Object.entries({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subject(),
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "couch:user",
      client_id: SYNC,
      client_secret: "nys_s",
      ...over,
    }).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const res = await gw.transport(
    new Request("https://nyuchi-api.internal/v1/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}
const errorOf = (r: { body: Record<string, unknown> }) =>
  (r.body.detail as { error?: string } | undefined)?.error;

const bearer = (r: { body: Record<string, unknown> }) =>
  `Bearer ${String(r.body.access_token)}`;

describe("who can get a grant", () => {
  it("the allow-listed internal key, for the scope alone", async () => {
    const r = await exchange();
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("couch:user");
    expect(Number(r.body.expires_in)).toBeLessThanOrEqual(300);
    expect(gw.authorize(bearer(r))).toMatchObject({
      ok: true,
      claims: { sub: "person-a", act: { sub: SYNC }, aud: "couch-sync" },
    });
  });

  it("not an internal key that is off the allow-list", async () => {
    const r = await exchange({ client_id: OTHER, client_secret: "nys_o" });
    expect([r.status, errorOf(r)]).toEqual([400, "invalid_scope"]);
  });

  it("not an external key, even when listed", async () => {
    const r = await exchange({ client_id: EXTERNAL, client_secret: "nys_e" });
    expect([r.status, errorOf(r)]).toEqual([400, "unauthorized_client"]);
  });

  it("not a key without identity", async () => {
    const r = await exchange({
      client_id: NO_IDENTITY,
      client_secret: "nys_n",
    });
    expect([r.status, errorOf(r)]).toEqual([400, "unauthorized_client"]);
  });

  it("not an unknown key or a wrong secret", async () => {
    expect(
      (await exchange({ client_id: "nyk_nobody", client_secret: "x" })).status,
    ).toBe(401);
    expect((await exchange({ client_secret: "wrong" })).status).toBe(401);
  });

  it.each(["couch:user identity", "identity couch:user", "couch:user couch"])(
    "never with another scope: %s",
    async (scope) => {
      const r = await exchange({ scope });
      expect([r.status, errorOf(r)]).toEqual([400, "invalid_scope"]);
    },
  );

  it("an exchange needs the exchange grant and an access-token subject", async () => {
    expect((await exchange({ grant_type: "client_credentials" })).status).toBe(
      400,
    );
    expect((await exchange({ subject_token: undefined })).status).toBe(400);
    expect((await exchange({ subject_token_type: "urn:x:jwt" })).status).toBe(
      400,
    );
  });
});

describe("the subject token", () => {
  it("must be issued to the gateway's console client", async () => {
    const r = await exchange({
      subject_token: subject({ clientId: "client_x" }),
    });
    expect([r.status, errorOf(r)]).toEqual([400, "invalid_grant"]);
  });

  it("is read from client_id, else aud, never iss", async () => {
    const claims = {
      sub: "user_a",
      exp: Math.floor(clock / 1000) + 300,
      iat: Math.floor(clock / 1000),
    };
    const viaAud = await exchange({
      subject_token: fakeJwt({ ...claims, aud: CONSOLE }),
    });
    expect(viaAud.status).toBe(200);
    const viaIss = await exchange({
      subject_token: fakeJwt({
        ...claims,
        iss: `https://api.workos.com/user_management/${CONSOLE}`,
      }),
    });
    expect(viaIss.status).toBe(400);
  });

  it("must be in date, a JWT, and name a user", async () => {
    expect(
      (await exchange({ subject_token: subject({ lifeSeconds: -1 }) })).status,
    ).toBe(400);
    expect((await exchange({ subject_token: "nope" })).status).toBe(400);
    const noSub = fakeJwt({
      client_id: CONSOLE,
      exp: Math.floor(clock / 1000) + 300,
    });
    expect((await exchange({ subject_token: noSub })).status).toBe(400);
  });
});

describe("the person", () => {
  it("must exist", async () => {
    const r = await exchange({
      subject_token: subject({ sub: "user_unknown" }),
    });
    expect([r.status, errorOf(r)]).toEqual([404, "person_not_found"]);
  });

  it("with a scheduled deletion gets no grant: 400 invalid_grant with its sentence", async () => {
    const r = await exchange({ subject_token: subject({ sub: "user_gone" }) });
    expect([r.status, errorOf(r)]).toEqual([400, "invalid_grant"]);
    expect(
      (r.body.detail as { error_description: string }).error_description,
    ).toBe("This person's deletion is scheduled.");
  });

  it("is held to 30 exchanges a minute, and the minute passes", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await exchange()).status);
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(200));
    expect(statuses[30]).toBe(429);
    clock += 61_000;
    expect((await exchange()).status).toBe(200);
  });
});

describe("how long it lives", () => {
  it("at most 300 s", async () => {
    const r = await exchange({ subject_token: subject({ lifeSeconds: 3600 }) });
    expect(r.body.expires_in).toBe(300);
  });
  it("never past the subject token", async () => {
    const r = await exchange({ subject_token: subject({ lifeSeconds: 60 }) });
    expect(r.body.expires_in).toBe(60);
  });
});

describe("using a grant", () => {
  async function grant(): Promise<string> {
    return bearer(await exchange());
  }

  it("is refused when it is expired", async () => {
    const g = await grant();
    clock += 301_000;
    expect(gw.authorize(g)).toEqual({ ok: false, status: 401 });
  });

  it("is refused at once when its client is taken off the allow-list (403)", async () => {
    const g = await grant();
    gw.syncClientIds.delete(SYNC);
    expect(gw.authorize(g)).toEqual({ ok: false, status: 403 });
  });

  it("is refused when it is not one the gateway issued, or breaks its own rules", async () => {
    const forged = (over: Record<string, unknown>) =>
      `Bearer ${fakeJwt({
        sub: "person-a",
        aud: "couch-sync",
        scope: "couch:user",
        act: { sub: SYNC },
        iat: Math.floor(clock / 1000),
        exp: Math.floor(clock / 1000) + 300,
        jti: "never-issued",
        ...over,
      })}`;
    expect(gw.authorize(forged({}))).toEqual({ ok: false, status: 401 });
    expect(gw.authorize(null)).toEqual({ ok: false, status: 401 });
    expect(gw.authorize("Basic abc")).toEqual({ ok: false, status: 401 });
    expect(gw.authorize("Bearer nope")).toEqual({ ok: false, status: 401 });
  });

  it("a platform sign-in audience is not a grant", async () => {
    const g = await grant();
    const claims = JSON.parse(
      Buffer.from(g.split(".")[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const asSignIn = `Bearer ${fakeJwt({ ...claims, aud: "authenticated" }, String(claims.jti))}`;
    expect(gw.authorize(asSignIn)).toEqual({ ok: false, status: 401 });
  });

  it("failNext injects an outage, a network error and a Retry-After", async () => {
    gw.failNext = { status: 503, count: 1 };
    expect((await exchange()).status).toBe(503);
    gw.failNext = { status: 429, count: 1, retryAfter: "7" };
    expect((await exchange()).status).toBe(429);
    gw.failNext = { status: 0, count: 1 };
    await expect(exchange()).rejects.toThrow();
    expect((await exchange()).status).toBe(200);
  });
});
