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
 *   - the visitor must be signed in (`withAuth()`; 401 otherwise). That is the
 *     ONLY 401 this route gives, and its body carries `SIGNED_OUT_CODE`: the
 *     page removes its local copy of the person's settings on exactly that, and
 *     on nothing else. Whatever the WorkOS token or the gateway say about a
 *     person who IS signed in (an access token missing or ended after a refresh
 *     that failed for a moment, a refused exchange) is 503 (the issuer);
 *   - the site must be set up for sync (503 `couch_unavailable`), checked
 *     BEFORE the limit so that an unconfigured site writes nothing to Mongo;
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
import { SIGNED_OUT_CODE } from "@/lib/couch-session-contract";
import { gatewayOrigin } from "@/lib/nyuchi-gateway";
import { checkUserRateLimit } from "@/lib/user-rate-limit";
import { logWarn } from "@/lib/observability";

export const dynamic = "force-dynamic";

/** Per user: [max requests, window seconds]. (A route file exports handlers only.) */
const COUCH_SESSION_LIMIT: [number, number] = [120, 3600];

const MESSAGES: Record<string, string> = {
  [SIGNED_OUT_CODE]: "Sign in to sync your settings.",
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
  // The only 401 this route gives, and the page removes its local copy of the
  // person's settings when it sees it, so it carries a code of its own.
  if (!userId) return errorResponse(401, SIGNED_OUT_CODE);

  // Not configured here: answer without touching Mongo. The limiter below is
  // a write per request, and a route that can do nothing must not spend the
  // person's hourly allowance (or the database's time) to say so.
  const apiOrigin = gatewayOrigin();
  const issuer = couchSessionIssuer();
  if (!apiOrigin || !issuer) return errorResponse(503, "couch_unavailable");

  const [max, window] = COUCH_SESSION_LIMIT;
  const limit = await checkUserRateLimit("couch-session", userId, max, window);
  if (!limit.allowed) {
    return errorResponse(429, "rate_limited", limit.retryAfterSeconds);
  }

  try {
    // What the issuer returns is already checked (a sync grant for a personal
    // database, not yet ended): `toCredential` in the issuer is the one place.
    const credential = await issuer.issue({ userId, accessToken });
    // An allow-list, not a pass-through: nothing the issuer returns beyond
    // these four fields can reach the browser.
    return NextResponse.json(
      {
        token: credential.token,
        expiresAt: new Date(credential.expiresAtMs).toISOString(),
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
