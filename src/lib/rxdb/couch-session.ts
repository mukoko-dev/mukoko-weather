/**
 * The browser's side of `POST /api/couch/session`: the same-origin route that
 * hands this page the short-lived credential for the person's own database.
 *
 * The route answers (and this module accepts) exactly:
 *
 *   { token, expiresAt, database, apiOrigin }
 *
 *   token       the short-lived credential, sent as `Authorization: Bearer`
 *   expiresAt   RFC 3339 time it stops working
 *   database    `user_<personId>`, the person's own database
 *   apiOrigin   the bare origin replication goes to (`https://api.nyuchi.com`)
 *
 * Anything else is refused, so a route that starts returning more cannot make
 * this client keep or forward it. The token lives in the engine's memory only:
 * never in storage, a cookie, the URL or a log.
 */

import { personIdFromDatabase } from "./couch-docs";

export interface CouchSession {
  token: string;
  expiresAtMs: number;
  /** `https://<api>/v1/couch/db/user_<personId>/` */
  databaseUrl: string;
  database: string;
  personId: string;
}

/** A failed session request; `status` 0 means no answer was read. */
export class CouchSessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`couch session ${status} ${code}`);
    this.name = "CouchSessionError";
  }
}

export const SESSION_ROUTE = "/api/couch/session";
const CODE_RE = /^[a-z_]{1,48}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A bare https origin (http only for localhost), else null. */
export function parseApiOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/** Validate a route answer into a session, or throw `CouchSessionError`. */
export function parseSessionBody(body: unknown): CouchSession {
  const bad = new CouchSessionError(502, "bad_session");
  if (!body || typeof body !== "object") throw bad;
  const b = body as Record<string, unknown>;
  const token = b.token;
  if (typeof token !== "string" || token.length < 16 || token.length > 4096) {
    throw bad;
  }
  const expiresAtMs =
    typeof b.expiresAt === "string" ? Date.parse(b.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) throw bad;
  const database = b.database;
  const personId = personIdFromDatabase(database);
  const origin = parseApiOrigin(b.apiOrigin);
  if (typeof database !== "string" || !personId || !origin) throw bad;
  return {
    token,
    expiresAtMs,
    database,
    personId,
    databaseUrl: `${origin}/v1/couch/db/${database}/`,
  };
}

/** Ask the route for a credential. Never retries; the engine decides that. */
export async function fetchCouchSession(
  fetchImpl: typeof fetch = fetch,
): Promise<CouchSession> {
  let response: Response;
  try {
    response = await fetchImpl(SESSION_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new CouchSessionError(0, "offline");
  }
  if (!response.ok) {
    let code = "unavailable";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && CODE_RE.test(body.error)) {
        code = body.error;
      }
    } catch {
      /* keep the generic code */
    }
    throw new CouchSessionError(response.status, code);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CouchSessionError(502, "bad_session");
  }
  return parseSessionBody(body);
}
