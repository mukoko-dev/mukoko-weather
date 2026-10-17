/**
 * Server-only client for the gateway's `/v1/app-keys` (nyuchi/api-gateway
 * #298/#312): developer keys the gateway mints, in its one `nyk_`/`nys_`
 * format, for the person whose own token the call carries.
 *
 * Every call sends this app's internal key (`X-Client-Id`/`X-Client-Secret`)
 * AND `Authorization: Bearer <person token>` from the exchange in
 * `gateway-person-token.ts`. The gateway refuses machine tokens and bare
 * person ids here, so the backend can never act for someone who has not
 * signed in.
 *
 * Responses are reduced to an allowlist before they reach the browser: a
 * listing is masked (prefix only), and the full key appears once, in the
 * create answer, exactly as the gateway returns it.
 */

import {
  gatewayConfig,
  gatewayErrorCode,
  gatewayRequest,
  parseRetryAfter,
  type GatewayConfig,
} from "./nyuchi-gateway";

export const APP_NAMESPACE = "weather";
export const APP_KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** What a listing may show. Never a secret or a hash. */
export interface MaskedAppKey {
  id: string;
  name: string | null;
  keyPrefix: string | null;
  planTier: string | null;
  readOnly: boolean;
  isActive: boolean;
  monthlyRequestLimit: number | null;
  monthlyRequestCount: number | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreatedAppKey extends MaskedAppKey {
  /** `nyk_….nys_…` — shown once, never retrievable again. */
  apiKey: string;
}

/** Codes the gateway answers that the UI may act on. */
export const PASSTHROUGH_CODES = new Set([
  "account_pending_deletion",
  "person_not_found",
  "key_limit_reached",
  "free_tier_key_limit",
  "app_not_on_free_tier",
  "plan_tier_not_accepted",
  "key_not_found",
]);

export class AppKeysError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "AppKeysError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function maskAppKey(raw: Record<string, unknown>): MaskedAppKey {
  return {
    id: str(raw._id) ?? str(raw.id) ?? "",
    name: str(raw.name),
    keyPrefix: str(raw.keyPrefix) ?? str(raw.clientId),
    planTier: str(raw.planTier),
    readOnly: raw.readOnly === true,
    isActive: raw.isActive !== false,
    monthlyRequestLimit: num(raw.monthlyRequestLimit),
    monthlyRequestCount: num(raw.monthlyRequestCount),
    createdAt: str(raw.createdAt),
    lastUsedAt: str(raw.lastUsedAt),
    expiresAt: str(raw.expiresAt),
    revokedAt: str(raw.revokedAt),
  };
}

async function failure(response: Response): Promise<AppKeysError> {
  const code = await gatewayErrorCode(response);
  const s = response.status;
  if (s === 401) {
    // The bearer was a freshly exchanged person token, so a 401 here
    // (person_token_required and the like) is not the user's session: it is
    // configuration (key, JWT secret, scope). A distinct operator error, so
    // the UI never loops on "sign in again".
    return new AppKeysError(503, "person_token_rejected");
  }
  if (s === 429) {
    return new AppKeysError(
      429,
      "rate_limited",
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  if (code === "person_not_found") {
    return new AppKeysError(409, "person_not_provisioned");
  }
  if (code && PASSTHROUGH_CODES.has(code)) {
    return new AppKeysError(s >= 500 ? 503 : s, code);
  }
  if (s === 404) return new AppKeysError(404, "key_not_found");
  if (s === 409) return new AppKeysError(409, "conflict");
  if (s === 400 || s === 422) return new AppKeysError(400, "invalid_request");
  if (s === 403) {
    // app_not_allowed / person_mismatch / scope: our key or token is wrong.
    return new AppKeysError(503, "gateway_unconfigured");
  }
  return new AppKeysError(503, "gateway_unavailable");
}

export function createAppKeysClient(config: () => GatewayConfig | null) {
  async function call(
    personToken: string,
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    const cfg = config();
    if (!cfg) throw new AppKeysError(503, "gateway_unconfigured");
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${personToken}`,
      "x-client-id": cfg.credentials.clientId,
      "x-client-secret": cfg.credentials.clientSecret,
    };
    if (init.body) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await cfg.transport(
        gatewayRequest(path, { method: init.method, headers, body: init.body }),
      );
    } catch {
      throw new AppKeysError(503, "gateway_unavailable");
    }
    if (response.status >= 300) throw await failure(response);
    return response;
  }

  async function json(response: Response): Promise<Record<string, unknown>> {
    try {
      const body = (await response.json()) as unknown;
      if (body && typeof body === "object") {
        return body as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
    throw new AppKeysError(503, "gateway_unavailable");
  }

  return {
    async list(personToken: string): Promise<MaskedAppKey[]> {
      const body = await json(
        await call(personToken, `/v1/app-keys?app=${APP_NAMESPACE}`, {
          method: "GET",
        }),
      );
      const keys = Array.isArray(body.keys) ? body.keys : [];
      return keys
        .filter(
          (k): k is Record<string, unknown> => !!k && typeof k === "object",
        )
        .map(maskAppKey);
    },

    async create(personToken: string, name: string): Promise<CreatedAppKey> {
      const body = await json(
        await call(personToken, "/v1/app-keys", {
          method: "POST",
          body: JSON.stringify({ app: APP_NAMESPACE, name }),
        }),
      );
      const apiKey = str(body.apiKey);
      if (!apiKey) throw new AppKeysError(503, "gateway_unavailable");
      return { ...maskAppKey(body), apiKey };
    },

    async revoke(personToken: string, id: string): Promise<void> {
      if (!APP_KEY_ID_RE.test(id)) {
        throw new AppKeysError(400, "invalid_id");
      }
      await call(personToken, `/v1/app-keys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
  };
}

export const appKeys = createAppKeysClient(() => gatewayConfig());
