/**
 * The `fetch` the RxDB CouchDB replication runs on: it carries the person's
 * credential, turns every non-2xx answer into a typed error, and keeps
 * documents this client does not own out of the device.
 *
 * What it does, and only this:
 *
 *   - `Authorization: Bearer <token>` on every request; `credentials: "omit"`
 *     (no cookie ever travels to the sync host), `cache: "no-store"`, no
 *     redirects followed, one timeout over the whole exchange.
 *   - Refuses any URL outside the one database it was built for.
 *   - A non-2xx answer throws `CouchHttpError(status)`. The replication plugin
 *     would otherwise try to read an error body as a list of changes, and a
 *     status it can read is what the engine's back-off decides on.
 *   - `GET .../_changes` answers are filtered to the ids this client owns
 *     (`isOwnedDocId`): a document of another type, written by another client
 *     (an encrypted saved place, a setting this client does not know), is never
 *     stored, never applied and never pushed. `last_seq` is kept, so the
 *     checkpoint still moves past it.
 *
 * Nothing here logs, and no error text carries the token, a URL or a body.
 */

import { isOwnedDocId } from "./couch-docs";

export const COUCH_REQUEST_TIMEOUT_MS = 25_000;

/** A non-2xx answer (or no answer at all: `status` 0). */
export class CouchHttpError extends Error {
  constructor(readonly status: number) {
    super(`couch ${status}`);
    this.name = "CouchHttpError";
  }
}

export type CouchFetch = typeof fetch;

export interface CouchFetchOptions {
  /** The database URL every request must stay under (ends with `/`). */
  databaseUrl: string;
  /** The current credential; null makes the request a 401 without sending it. */
  getToken: () => string | null;
  baseFetch?: typeof fetch;
  timeoutMs?: number;
}

interface ChangesRow {
  id?: unknown;
}

function isChangesFeed(url: URL, method: string): boolean {
  return method === "GET" && url.pathname.endsWith("/_changes");
}

/** Keep only the rows this client owns; the rest of the answer is untouched. */
export function filterChanges(body: unknown): unknown {
  if (!body || typeof body !== "object") throw new CouchHttpError(502);
  const feed = body as { results?: unknown };
  if (!Array.isArray(feed.results)) throw new CouchHttpError(502);
  return {
    ...feed,
    results: (feed.results as ChangesRow[]).filter(
      (row) => !!row && isOwnedDocId(row.id),
    ),
  };
}

export function createCouchFetch(options: CouchFetchOptions): CouchFetch {
  const baseFetch = options.baseFetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? COUCH_REQUEST_TIMEOUT_MS;

  return async (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(options.databaseUrl)) {
      // The plugin builds its URLs from the database URL only; anything else
      // is a bug and must not carry the credential anywhere.
      throw new CouchHttpError(0);
    }
    const token = options.getToken();
    if (!token) throw new CouchHttpError(401);

    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await baseFetch(url, {
          ...init,
          method,
          headers,
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

      if (isChangesFeed(new URL(url), method)) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new CouchHttpError(502);
        }
        return new Response(JSON.stringify(filterChanges(body)), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  };
}
