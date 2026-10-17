/**
 * Shared plumbing for /api/app-keys: the sign-in gate, the per-request
 * person-token exchange, and one error shape. Nothing here ever puts the
 * WorkOS access token or the person token in a response or a log.
 */

import { NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import {
  forgetPersonTokens,
  getPersonToken,
  PersonTokenError,
} from "@/lib/gateway-person-token";
import { AppKeysError } from "@/lib/gateway-app-keys";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

const MESSAGES: Record<string, string> = {
  unauthorized: "Sign in to manage API keys.",
  reauth_required: "Your session has ended. Sign in again.",
  person_not_provisioned:
    "Your Mukoko account is not set up on the platform yet. Sign out and sign in again, then retry.",
  account_pending_deletion: "This account is scheduled for deletion.",
  wrong_workos_client:
    "API keys are not available yet: this site does not sign in through the Mukoko Account client.",
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
 * Run `fn` with the signed-in user's person token. 401 when anonymous; every
 * exchange or gateway failure maps to a fixed, token-free answer.
 */
export async function withPersonToken(
  fn: (personToken: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const { user, accessToken } = await withAuth();
  if (!user) return errorResponse(401, "unauthorized");
  try {
    const { token } = await getPersonToken(user.id, accessToken);
    return await fn(token);
  } catch (err) {
    if (err instanceof PersonTokenError) {
      return errorResponse(err.status, err.code, err.retryAfterSeconds);
    }
    if (err instanceof AppKeysError) {
      if (err.status === 401) forgetPersonTokens(user.id);
      return errorResponse(err.status, err.code, err.retryAfterSeconds);
    }
    return errorResponse(503, "gateway_unavailable");
  }
}
