/**
 * Guards shared by the signed-in, state-changing API routes
 * (`/api/app-keys`, `/api/couch/session`): the CSRF check, the signed-in
 * session and the one cache header. Extracted from `app-keys/shared.ts`
 * unchanged, so a second route reuses the rule instead of copying it.
 */

import { withAuth } from "@workos-inc/authkit-nextjs";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export type CrossSiteRefusal = "unsupported_media_type" | "forbidden_origin";

/**
 * CSRF guard for state-changing calls: `Content-Type: application/json`
 * (a cross-site form cannot send it without a CORS preflight, which these
 * routes never answer) and an `Origin` equal to this site's own origin.
 * Same-origin only: no localhost, station-console or other first-party
 * origin. A missing or `null` Origin is refused. Returns null when the
 * request passes, else why it was refused.
 */
export function sameOriginJsonRefusal(req: Request): CrossSiteRefusal | null {
  const type = (req.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (type !== "application/json") return "unsupported_media_type";
  const origin = req.headers.get("origin");
  let self: string | null = null;
  try {
    self = new URL(req.url).origin;
  } catch {
    self = null;
  }
  const allowed = !!origin && origin !== "null" && !!self && origin === self;
  return allowed ? null : "forbidden_origin";
}

/** The name of AuthKit's session cookie: `WORKOS_COOKIE_NAME`, else `wos-session`. */
export function sessionCookieName(): string {
  return process.env.WORKOS_COOKIE_NAME || "wos-session";
}

/**
 * Whether the request carries a (non-empty) AuthKit session cookie. That is how
 * "nobody is signed in" is told from "AuthKit could not say who": `withAuth()`
 * also answers `{ user: null }` when a refresh of the access token FAILED while
 * the sealed session cookie is intact (a WorkOS outage, or a single-use refresh
 * token that a concurrent request had already used), so a missing user ALONE
 * proves nothing. A request with no session cookie at all is the one that is
 * certainly not signed in.
 */
export function hasSessionCookie(req: Request): boolean {
  const header = req.headers.get("cookie");
  if (!header) return false;
  const name = sessionCookieName();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name && part.slice(eq + 1).trim() !== "") {
      return true;
    }
  }
  return false;
}

export interface CurrentSession {
  userId: string | null;
  accessToken?: string;
}

/** The signed-in user, or `userId: null` (also when AuthKit cannot say). */
export async function currentSession(): Promise<CurrentSession> {
  try {
    const { user, accessToken } = await withAuth();
    return { userId: user?.id ?? null, accessToken };
  } catch {
    // e.g. a path the proxy skipped (no AuthKit headers): treat as signed out.
    return { userId: null };
  }
}

const PROBLEM_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export interface ProblemOptions {
  /** Sent as `Retry-After` (seconds). */
  retryAfterSeconds?: number;
  /** Defaults to `no-store`. */
  cacheControl?: string;
}

/**
 * An RFC 9457 problem answer (`application/problem+json`): `type`, `title`,
 * `status`, `detail`, plus a stable machine `code`. `detail` must be fixed
 * text, never built from the request, so nothing a caller sent can come back
 * in an error or a log. For a route that answers machines; existing routes
 * keep their own answers.
 */
export function problemResponse(
  status: number,
  code: string,
  detail: string,
  options: ProblemOptions = {},
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/problem+json",
    "Cache-Control": options.cacheControl ?? NO_STORE["Cache-Control"],
  };
  if (options.retryAfterSeconds) {
    headers["Retry-After"] = String(options.retryAfterSeconds);
  }
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: PROBLEM_TITLES[status] ?? "Error",
      status,
      code,
      detail,
    }),
    { status, headers },
  );
}

/**
 * The request body as text, or null once it passes `maxBytes`. Read chunk by
 * chunk, so a body that does not declare its length is cut off at the limit
 * rather than read whole (and the stream is cancelled).
 */
export async function readBoundedText(
  req: Request,
  maxBytes: number,
): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
