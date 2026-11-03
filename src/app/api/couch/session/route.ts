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
 *   - the visitor must be signed in (`withAuth()`). The ONLY 401 this route
 *     gives is for a request with NO session cookie at all, and its body
 *     carries `SIGNED_OUT_CODE`: the page counts it, and removes its local copy
 *     of the person's settings only when it sees it again on a later page load.
 *     `withAuth()` also gives no user when AuthKit's refresh of the access
 *     token FAILS while the sealed session cookie is intact (a WorkOS outage; a
 *     single-use refresh token that a concurrent request used first), so a
 *     cookie with no user is 503, not 401 (`hasSessionCookie`). Whatever the
 *     WorkOS token or the gateway say about a person who IS signed in (an
 *     access token missing or ended, a refused exchange) is 503 too (the
 *     issuer);
 *   - the site must be set up for sync (503 `couch_unavailable`), checked
 *     BEFORE the limit so that an unconfigured site writes nothing to Mongo;
 *   - the issuer's local checks (`precheck`: no I/O) next, also before either
 *     counter: an access token that is missing, ended or too short to make a
 *     grant from is 503 `couch_unavailable` and spends nothing;
 *   - a per-user limit (Mongo, `checkUserRateLimit`, 120 an hour: the
 *     credential lives five minutes at most and the page renews it a minute
 *     before, so one visible tab asks about fifteen times an hour and a few
 *     tabs stay well inside; the gateway holds a person to 30 exchanges a
 *     minute on top);
 *   - a site-wide budget (`couch-session-budget.ts`, 6 every 20 s) for the
 *     gateway's token endpoint, 30 a minute for this site's one key, which
 *     `/api/app-keys` shares: sync cannot use up the key; a refused request
 *     spends no exchange;
 *   - no cookie, WorkOS token or body is forwarded, logged or returned.
 *
 * It answers exactly `{ token, expiresIn, database, apiOrigin }` and nothing
 * else, `Cache-Control: no-store`. `expiresIn` is how many seconds the
 * credential lives from the moment it was issued (the server's clock at issue
 * time): a duration, because the page's clock is not this one, and an absolute
 * time compared with a device clock a few minutes off breaks a five-minute
 * credential. It is not in `CORS_POLICY.open`: only this site's own pages can
 * call it.
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
  hasSessionCookie,
  NO_STORE,
  sameOriginJsonRefusal,
} from "@/lib/api-route-guards";
import { syncBudget } from "@/lib/couch-session-budget";
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
  if (!userId) {
    // A session cookie with no user is AuthKit failing to refresh (or the
    // middleware having been skipped), not a sign-out: the sealed cookie is
    // still there and a later request may well work. Say "not available now"
    // (503, which the page backs off on and deletes nothing for).
    if (hasSessionCookie(req)) return errorResponse(503, "couch_unavailable");
    // The only 401 this route gives: no session cookie at all. The page counts
    // it (it removes its local copy of the person's settings only once it has
    // seen it again on a later page load), so it carries a code of its own.
    return errorResponse(401, SIGNED_OUT_CODE);
  }

  // Not configured here: answer without touching Mongo. The limiter below is
  // a write per request, and a route that can do nothing must not spend the
  // person's hourly allowance (or the database's time) to say so.
  const apiOrigin = gatewayOrigin();
  const issuer = couchSessionIssuer();
  if (!apiOrigin || !issuer) return errorResponse(503, "couch_unavailable");

  // Then the issuer's own LOCAL checks (an access token that is missing, ended
  // or too short to make a grant from), before either counter: such a request
  // can only be refused, retrying at once does not cure it, and it must not
  // spend the person's hourly allowance (a Mongo write) or one of the site's
  // exchanges, which a person stuck with such a token would otherwise burn on
  // every retry of every tab.
  const unissuable = issuer.precheck({ userId, accessToken });
  if (unissuable) {
    return errorResponse(
      unissuable.status,
      unissuable.code,
      unissuable.retryAfterSeconds,
    );
  }

  const [max, window] = COUCH_SESSION_LIMIT;
  const limit = await checkUserRateLimit("couch-session", userId, max, window);
  if (!limit.allowed) {
    return errorResponse(429, "rate_limited", limit.retryAfterSeconds);
  }

  // Then the site-wide budget for the gateway's token endpoint, which this
  // site's one key shares with /api/app-keys (`couch-session-budget.ts`). After
  // the person's own limit, so that one person cannot spend it for everybody,
  // and before the exchange, so that a refused request spends nothing.
  const budget = await syncBudget.spend();
  if (!budget.allowed) {
    return errorResponse(429, "rate_limited", budget.retryAfterSeconds);
  }

  try {
    // What the issuer returns is already checked (a sync grant for a personal
    // database, not yet ended): `toCredential` in the issuer is the one place.
    const credential = await issuer.issue({ userId, accessToken });
    // A duration the page can use, never a time of day it would have to compare
    // with its own clock.
    if (
      !Number.isInteger(credential.expiresInSeconds) ||
      credential.expiresInSeconds < 1
    ) {
      throw new CouchIssueError("couch_unavailable");
    }
    // An allow-list, not a pass-through: nothing the issuer returns beyond
    // these four fields can reach the browser.
    return NextResponse.json(
      {
        token: credential.token,
        expiresIn: credential.expiresInSeconds,
        database: credential.database,
        apiOrigin,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof CouchIssueError) {
      if (err.code === "rate_limited") {
        // The gateway's own 429: the key's ceiling was reached by something
        // this site's budget does not see. Stop sending exchanges for the time
        // it named; the line is written once per cooldown, with no person in it.
        if (syncBudget.noteGatewayRateLimit(err.retryAfterSeconds)) {
          logWarn({
            source: "nyuchi-gateway",
            message:
              "Gateway rate-limited the sync grant exchange; sync exchanges paused briefly",
            meta: { retryAfterSeconds: err.retryAfterSeconds ?? null },
          });
        }
      }
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
