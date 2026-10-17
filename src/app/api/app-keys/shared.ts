/**
 * Shared plumbing for /api/app-keys: the CSRF guard, the sign-in gate, the
 * per-user rate limit, the per-request person-token exchange, and one error
 * shape. Nothing here ever puts the WorkOS access token or the person token
 * in a response or a log.
 */

import { NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import {
  forgetPersonTokens,
  getPersonToken,
  PersonTokenError,
} from "@/lib/gateway-person-token";
import { AppKeysError } from "@/lib/gateway-app-keys";
import { FIRST_PARTY_ORIGINS } from "@/lib/security-headers";
import { checkUserRateLimit } from "@/lib/user-rate-limit";
import { logWarn } from "@/lib/observability";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export type AppKeysAction = "list" | "create" | "revoke";

/** Per user: [max requests, window seconds]. */
export const APP_KEYS_LIMITS: Record<AppKeysAction, [number, number]> = {
  list: [10, 60],
  create: [5, 3600],
  revoke: [20, 3600],
};

const MESSAGES: Record<string, string> = {
  unauthorized: "Sign in to manage API keys.",
  reauth_required: "Your session has ended. Sign in again.",
  person_not_provisioned:
    "Your Mukoko account is not set up on the platform yet. Sign out and sign in again, then retry.",
  account_pending_deletion: "This account is scheduled for deletion.",
  wrong_workos_client:
    "API keys are not available yet: this site does not sign in through the Mukoko Account client.",
  exchange_refused:
    "API keys are not available right now (sign-in was not accepted by the platform).",
  person_token_rejected: "API keys are not available right now.",
  gateway_unconfigured: "API keys are not available right now.",
  gateway_unavailable:
    "API keys are temporarily unavailable. Try again shortly.",
  rate_limited: "Too many requests. Try again shortly.",
  key_limit_reached:
    "You have reached the key limit. Revoke one to create another.",
  free_tier_key_limit: "The free plan's key limit for your family is reached.",
  app_not_on_free_tier: "This API is not on the free plan.",
  plan_tier_not_accepted: "Keys for your plan are not available yet.",
  key_not_found: "Key not found.",
  invalid_request: "The request was not accepted.",
  invalid_id: "Invalid key id.",
  invalid_label: "A non-empty label (max 60 characters) is required.",
  conflict: "The request conflicts with the current state.",
  forbidden_origin: "Cross-site requests are not allowed.",
  unsupported_media_type: "Send the request as application/json.",
};

export function errorResponse(
  status: number,
  error: string,
  retryAfterSeconds?: number,
): NextResponse {
  const headers: Record<string, string> = { ...NO_STORE };
  if (retryAfterSeconds) headers["Retry-After"] = String(retryAfterSeconds);
  return NextResponse.json(
    { error, message: MESSAGES[error] ?? MESSAGES.gateway_unavailable },
    { status, headers },
  );
}

/**
 * CSRF guard for state-changing calls: `Content-Type: application/json`
 * (a cross-site form cannot send it without a CORS preflight, which this
 * route never answers) and an `Origin` that is this site or a first-party
 * origin. A missing Origin is refused. Returns null when the request passes.
 */
export function rejectCrossSite(req: Request): NextResponse | null {
  const type = (req.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (type !== "application/json") {
    return errorResponse(415, "unsupported_media_type");
  }
  const origin = req.headers.get("origin");
  let self: string | null = null;
  try {
    self = new URL(req.url).origin;
  } catch {
    self = null;
  }
  const allowed =
    !!origin &&
    origin !== "null" &&
    (origin === self ||
      (FIRST_PARTY_ORIGINS as readonly string[]).includes(origin));
  return allowed ? null : errorResponse(403, "forbidden_origin");
}

async function currentSession(): Promise<{
  userId: string | null;
  accessToken?: string;
}> {
  try {
    const { user, accessToken } = await withAuth();
    return { userId: user?.id ?? null, accessToken };
  } catch {
    // e.g. a path the proxy skipped (no AuthKit headers): treat as signed out.
    return { userId: null };
  }
}

/**
 * Run `fn` with the signed-in user's person token. 401 when anonymous, 429
 * over the per-user limit; every exchange or gateway failure maps to a
 * fixed, token-free answer.
 */
export async function withPersonToken(
  action: AppKeysAction,
  fn: (personToken: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const { userId, accessToken } = await currentSession();
  if (!userId) return errorResponse(401, "unauthorized");

  const [max, window] = APP_KEYS_LIMITS[action];
  const limit = await checkUserRateLimit(
    `app-keys-${action}`,
    userId,
    max,
    window,
  );
  if (!limit.allowed) {
    return errorResponse(429, "rate_limited", limit.retryAfterSeconds);
  }

  try {
    const { token } = await getPersonToken(userId, accessToken);
    return await fn(token);
  } catch (err) {
    if (err instanceof PersonTokenError) {
      return errorResponse(err.status, err.code, err.retryAfterSeconds);
    }
    if (err instanceof AppKeysError) {
      if (err.code === "person_token_rejected") forgetPersonTokens(userId);
      return errorResponse(err.status, err.code, err.retryAfterSeconds);
    }
    // Ids only: never the error text, which could echo request material.
    logWarn({
      source: "nyuchi-gateway",
      message: "Unexpected error in /api/app-keys",
      meta: {
        action,
        errorName: err instanceof Error ? err.name : typeof err,
      },
    });
    return errorResponse(503, "gateway_unavailable");
  }
}
