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
 *   - Refuses any URL outside the one database it was built for (and the exact
 *     extra URLs it was given: the gateway's personal route).
 *   - Reads every response body inside the timeout (`requestWithin`, the one
 *     place a request, its timeout and its abort are put together; the
 *     same-origin session route uses it too) and hands the caller a body that is
 *     already in memory.
 *   - A non-2xx answer throws `CouchHttpError(status)`. The replication plugin
 *     would otherwise try to read an error body as a list of changes, and a
 *     status it can read is what the engine's back-off decides on.
 *   - `GET .../_changes` is sent as `POST .../_changes?filter=_doc_ids` with the
 *     ids this client owns (`ownedDocIds`: the two settings and one per
 *     activity the app offers, a short fixed list) and the answer is filtered
 *     to them again (`isOwnedDocId`). A document of another type, written by
 *     another client (an encrypted saved place, a setting this client does not
 *     know), is therefore never sent, never stored, never applied and never
 *     pushed.
 *
 *     Why ask the server rather than drop rows afterwards: RxDB's pull stops
 *     WITHOUT saving its checkpoint when a page has no documents, and treats a
 *     page with fewer documents than its batch as the end of the feed. Rows
 *     dropped after the fact would leave the next cycle on the same `since` for
 *     ever when a whole page was foreign, and end every cycle after one page
 *     when a few of each page were ours: the person's own settings behind a long
 *     run of another client's documents (one event per interaction, say) would
 *     never arrive. The gateway allows the filter and its body
 *     (`couch_proxy_policy.py`: `filter` `_doc_ids`, a `doc_ids` body on
 *     `POST _changes`), and a filtered feed still ends at the end of the
 *     database, so the checkpoint moves.
 *
 * Nothing here logs, and no error text carries the token, a URL or a body.
 */

import { isOwnedDocId, ownedDocIds } from "./couch-docs";

export const COUCH_REQUEST_TIMEOUT_MS = 25_000;

/** A non-2xx answer (or no answer at all: `status` 0). */
export class CouchHttpError extends Error {
  constructor(readonly status: number) {
    super(`couch ${status}`);
    this.name = "CouchHttpError";
  }
}

export type CouchFetch = typeof fetch;

export interface RequestLimits {
  /** One timeout over the whole exchange: the answer AND reading its body. */
  timeoutMs: number;
  /**
   * Abandon the request, in flight or yet to be made, when this fires (a page
   * that is going away).
   */
  signal?: AbortSignal;
}

/**
 * ONE request under ONE timeout, and the only place in the sync transport that
 * builds an `AbortController` or arms a timer. The answer AND `read`'s use of it
 * (the body) must finish in time, so a response whose body never arrives cannot
 * hold the sync for ever; a request that cannot be made or is cut off is the
 * caller's "no answer" error (`noAnswer`), whose text never carries the URL, a
 * header or the token. `read` turns the response into the caller's result and
 * decides what a non-2xx answer is. Every request of this layer goes through
 * here: the replication's own (`createCouchFetch`), the gateway's personal route
 * (also `createCouchFetch`) and the same-origin session route
 * (`fetchCouchSession`).
 */
export async function requestWithin<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  limits: RequestLimits,
  noAnswer: () => Error,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  if (limits.signal?.aborted) throw noAnswer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const abandon = () => controller.abort();
  limits.signal?.addEventListener("abort", abandon);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch {
      // Offline, DNS, CORS, timeout, aborted: no answer to read.
      throw noAnswer();
    }
    return await read(response);
  } finally {
    clearTimeout(timer);
    limits.signal?.removeEventListener("abort", abandon);
  }
}

export interface CouchFetchOptions {
  /** The database URL every request must stay under (ends with `/`). */
  databaseUrl: string;
  /**
   * Exact URLs, besides the database, the credential may be sent to (the
   * gateway's `POST /v1/couch/personal`, which prepares the database). Exact:
   * not a prefix, not with a query.
   */
  extraUrls?: string[];
  /** The current credential; null makes the request a 401 without sending it. */
  getToken: () => string | null;
  baseFetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Abandon every request, in flight or yet to be made, when this fires (a
   * page that is going away): they end as "no answer" (`status` 0).
   */
  signal?: AbortSignal;
}

interface ChangesRow {
  id?: unknown;
}

function isChangesFeed(url: URL, method: string): boolean {
  return method === "GET" && url.pathname.endsWith("/_changes");
}

/**
 * Keep only the rows this client owns; the rest of the answer is untouched.
 *
 * The server was asked for these ids only, so a foreign row means it ignored
 * the filter. Dropping it is right (it must never reach the device), but a page
 * that held rows and ends up with none must not look like an empty feed: RxDB
 * would not move its checkpoint past it and every later cycle would meet the
 * same page. That is a failure (502) the engine backs off on, not a silent
 * stall.
 */
export function filterChanges(body: unknown): unknown {
  if (!body || typeof body !== "object") throw new CouchHttpError(502);
  const feed = body as { results?: unknown };
  if (!Array.isArray(feed.results)) throw new CouchHttpError(502);
  const rows = feed.results as ChangesRow[];
  const owned = rows.filter((row) => !!row && isOwnedDocId(row.id));
  if (rows.length > 0 && owned.length === 0) throw new CouchHttpError(502);
  return { ...feed, results: owned };
}

export function createCouchFetch(options: CouchFetchOptions): CouchFetch {
  const baseFetch = options.baseFetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? COUCH_REQUEST_TIMEOUT_MS;
  const extraUrls = options.extraUrls ?? [];

  return async (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(options.databaseUrl) && !extraUrls.includes(url)) {
      // The plugin builds its URLs from the database URL only; anything else
      // is a bug and must not carry the credential anywhere.
      throw new CouchHttpError(0);
    }
    const token = options.getToken();
    if (!token) throw new CouchHttpError(401);

    let method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");

    // The changes feed is asked for this client's ids only (see above).
    const changes = isChangesFeed(new URL(url), method);
    let target = url;
    let body = init.body;
    if (changes) {
      const filtered = new URL(url);
      filtered.searchParams.set("filter", "_doc_ids");
      target = filtered.href;
      method = "POST";
      body = JSON.stringify({ doc_ids: ownedDocIds() });
      headers.set("content-type", "application/json");
    }

    return requestWithin(
      baseFetch,
      target,
      {
        ...init,
        method,
        headers,
        body,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      },
      { timeoutMs, signal: options.signal },
      () => new CouchHttpError(0),
      async (response) => {
        if (!response.ok) throw new CouchHttpError(response.status);
        // The body is read here, inside the timeout, and handed on whole: the
        // caller (the plugin, or `ensurePersonalDatabase`) reads a body that is
        // already in memory and cannot stall on it.
        let text: string;
        try {
          text = await response.text();
        } catch {
          throw new CouchHttpError(502);
        }
        if (changes) {
          let feed: unknown;
          try {
            feed = JSON.parse(text);
          } catch {
            throw new CouchHttpError(502);
          }
          text = JSON.stringify(filterChanges(feed));
        }
        return new Response(
          response.status === 204 || response.status === 205 ? null : text,
          {
            status: response.status,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
  };
}
