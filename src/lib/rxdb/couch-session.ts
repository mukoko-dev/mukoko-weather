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
 *
 * The token is the gateway's sync grant (`couch:user`, five minutes at most;
 * `lib/couch-session-issuer.ts`). The gateway's replication route never
 * creates a database, so before the first replication of a run the page also
 * asks the gateway to prepare the person's database (`ensurePersonalDatabase`,
 * `POST /v1/couch/personal`, which accepts the grant for its own subject only).
 */

import { parseBareOrigin } from "../bare-origin";
import { COUCH_SESSION_PATH } from "../couch-session-timing";
import { COUCH_REQUEST_TIMEOUT_MS, CouchHttpError } from "./couch-fetch";
import { personIdFromDatabase } from "../couch-session-contract";

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

const CODE_RE = /^[a-z_]{1,48}$/;

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
  // The same rule the server applied to `NYUCHI_API_URL` before handing the
  // origin over, from the one module both import.
  const origin = parseBareOrigin(b.apiOrigin);
  if (typeof database !== "string" || !personId || !origin) throw bad;
  return {
    token,
    expiresAtMs,
    database,
    personId,
    databaseUrl: `${origin}/v1/couch/db/${database}/`,
  };
}

/**
 * Ask the route for a credential. Never retries; the engine decides that. One
 * timeout covers the whole exchange (the answer and its body): a request that
 * never answers must not hold the sync for ever, because every later cycle
 * queues behind it. Past it the answer is "no answer" (`status` 0).
 */
export async function fetchCouchSession(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = COUCH_REQUEST_TIMEOUT_MS,
): Promise<CouchSession> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(COUCH_SESSION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

/** `https://<api>/v1/couch/personal`, on the same origin as the database URL. */
export function personalDatabaseUrl(session: CouchSession): string {
  return new URL("/v1/couch/personal", session.databaseUrl).href;
}

/**
 * Ask the gateway to make sure the person's own database exists and enforces
 * its owner-only rules (`POST /v1/couch/personal`). The replication route only
 * forwards to a database that is already there, so this runs once per person
 * per run, before the first replication, and again after a 404.
 *
 * The grant is the bearer; no cookie travels (`credentials: "omit"`), nothing
 * is sent in a body (the gateway derives the database from the grant's
 * subject and never reads the request for it), and the answer must name this
 * very database and say `ready`. Failures throw `CouchHttpError` with the
 * status (0 when nothing was answered), which the engine backs off on: 503 is
 * the gateway saying CouchDB is not ready yet, 403 that the grant's client is
 * no longer permitted or the person's deletion has started, 429 the per-IP
 * limit. Nothing here logs or puts the token in an error.
 */
export async function ensurePersonalDatabase(
  session: CouchSession,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = COUCH_REQUEST_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(personalDatabaseUrl(session), {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          accept: "application/json",
        },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      // Offline, DNS, CORS, timeout, aborted: no answer to read.
      throw new CouchHttpError(0);
    }
    if (!response.ok) throw new CouchHttpError(response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CouchHttpError(502);
    }
    const answer = (body && typeof body === "object" ? body : {}) as {
      ready?: unknown;
      database?: unknown;
      person_id?: unknown;
    };
    if (
      answer.ready !== true ||
      answer.database !== session.database ||
      answer.person_id !== session.personId
    ) {
      throw new CouchHttpError(502);
    }
  } finally {
    clearTimeout(timer);
  }
}
