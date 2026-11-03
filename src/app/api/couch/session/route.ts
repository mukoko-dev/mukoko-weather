/**
 * POST /api/couch/session: the short-lived credential for the signed-in
 * person's own CouchDB database (`user_<personId>`), behind
 * `FLAGS.couch_sync` on the client (#396, web slice).
 *
 * The pattern of `/api/app-keys`, to the letter:
 *
 *   - `Content-Type: application/json` and a same-origin `Origin` are
 *     required (415 / 403), checked before anything else, so a cross-site
 *     form costs nothing;
 *   - the visitor must be signed in (`withAuth()`; 401 otherwise);
 *   - a per-user limit (Mongo, `checkUserRateLimit`, 120 an hour: the
 *     credential lives five minutes at most and the page renews it a minute
 *     before, so one visible tab asks about fifteen times an hour and a few
 *     tabs stay well inside; the gateway holds a person to 30 exchanges a
 *     minute on top);
 *   - no cookie, WorkOS token or body is forwarded, logged or returned.
 *
 * It answers exactly `{ token, expiresAt, database, apiOrigin }` and nothing
 * else, `Cache-Control: no-store`. It is not in `CORS_POLICY.open`: only this
 * site's own pages can call it.
 *
 * The credential is the gateway's CouchDB sync grant (`couch:user`), made by
 * `couchSessionIssuer()` (`@/lib/couch-session-issuer`, which cites the
 * gateway code it was checked against): the person's own WorkOS access token
 * traded on the server, the grant returned to the page as the replication
 * bearer. Without the gateway origin, this app's key or `WORKOS_CLIENT_ID` the
 * issuer is null and the answer after the guards is 503 `couch_unavailable`,
 * which the client treats as "stay local-only, back off". It is the same
 * answer while the owner steps are not done (the client id on the gateway's
 * allow-list, CouchDB's JWT handler: docs/couchdb-sync.md). The API origin
 * comes from `NYUCHI_API_URL`; no new environment variable and no new secret.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  currentSession,
  NO_STORE,
  sameOriginJsonRefusal,
} from "@/lib/api-route-guards";
import {
  CouchIssueError,
  couchSessionIssuer,
} from "@/lib/couch-session-issuer";
import { personIdFromDatabase } from "@/lib/rxdb/couch-docs";
import { gatewayOrigin } from "@/lib/nyuchi-gateway";
import { checkUserRateLimit } from "@/lib/user-rate-limit";
import { logWarn } from "@/lib/observability";

export const dynamic = "force-dynamic";

/** Per user: [max requests, window seconds]. (A route file exports handlers only.) */
const COUCH_SESSION_LIMIT: [number, number] = [120, 3600];

const MESSAGES: Record<string, string> = {
  unauthorized: "Sign in to sync your settings.",
  reauth_required: "Your session has ended. Sign in again.",
  account_pending_deletion: "This account is scheduled for deletion.",
  rate_limited: "Too many requests. Try again shortly.",
  couch_unavailable: "Sync is not available right now.",
  forbidden_origin: "Cross-site requests are not allowed.",
  unsupported_media_type: "Send the request as application/json.",
};

function errorResponse(
  status: number,
  error: string,
  retryAfterSeconds?: number,
): NextResponse {
  const headers: Record<string, string> = { ...NO_STORE };
  if (retryAfterSeconds) headers["Retry-After"] = String(retryAfterSeconds);
  return NextResponse.json(
    { error, message: MESSAGES[error] ?? MESSAGES.couch_unavailable },
    { status, headers },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const refusal = sameOriginJsonRefusal(req);
  if (refusal) {
    return errorResponse(
      refusal === "unsupported_media_type" ? 415 : 403,
      refusal,
    );
  }

  const { userId, accessToken } = await currentSession();
  if (!userId) return errorResponse(401, "unauthorized");

  const [max, window] = COUCH_SESSION_LIMIT;
  const limit = await checkUserRateLimit("couch-session", userId, max, window);
  if (!limit.allowed) {
    return errorResponse(429, "rate_limited", limit.retryAfterSeconds);
  }

  const apiOrigin = gatewayOrigin();
  const issuer = couchSessionIssuer();
  if (!apiOrigin || !issuer) return errorResponse(503, "couch_unavailable");

  try {
    const credential = await issuer.issue({ userId, accessToken });
    const personId = personIdFromDatabase(credential.database);
    const expiresAt = new Date(credential.expiresAtMs);
    if (
      !personId ||
      typeof credential.token !== "string" ||
      credential.token.length < 16 ||
      Number.isNaN(expiresAt.getTime())
    ) {
      return errorResponse(503, "couch_unavailable");
    }
    // An allow-list, not a pass-through: nothing the issuer returns beyond
    // these four fields can reach the browser.
    return NextResponse.json(
      {
        token: credential.token,
        expiresAt: expiresAt.toISOString(),
        database: credential.database,
        apiOrigin,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof CouchIssueError) {
      return errorResponse(err.status, err.code, err.retryAfterSeconds);
    }
    // Names only: never the error text, which could echo request material.
    logWarn({
      source: "nyuchi-gateway",
      message: "Unexpected error in /api/couch/session",
      meta: { errorName: err instanceof Error ? err.name : typeof err },
    });
    return errorResponse(503, "couch_unavailable");
  }
}
