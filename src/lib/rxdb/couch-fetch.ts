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
 *     extra URLs it was given: the gateway's personal route). The URL is parsed,
 *     not prefix-matched: same origin, no user information, no dot segment however
 *     spelled, no backslash, and a path under the database's own (`isAllowedUrl`).
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
 *   - The plugin's push check (`POST _all_docs` with `include_docs`) answers a
 *     deleted document with no body, which the plugin reads as "nothing there":
 *     it would write over a deletion made elsewhere whatever the times say. The
 *     deleted revision is read back (`GET <id>?rev=`, `withDeletedDocs`) so the
 *     conflict rule, which orders a delete by its `updatedAt` like any edit, is
 *     asked.
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

/** `%2e` / `%2E` and `.` read the same to a URL parser and to a server. */
const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i;
/** The path of an absolute URL as written, before any parser normalises it. */
const RAW_PATH_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i;

/**
 * Whether the path as WRITTEN could climb out of where it starts or hide a
 * separator. The URL parser removes `..` (and `%2e%2e`) before anything can
 * look at them, so this reads the text itself: no dot segment, however it is
 * spelled or how often it is percent-encoded; no empty segment but a final one;
 * no backslash and no encoded slash or backslash (a server may read them as
 * separators); no `@`.
 */
function pathIsPlain(raw: string): boolean {
  if (raw.includes("\\") || raw.includes("@")) return false;
  const match = RAW_PATH_RE.exec(raw);
  if (!match) return false;
  const segments = match[1].split("/").slice(1); // the path starts with "/"
  for (let i = 0; i < segments.length; i += 1) {
    let segment = segments[i];
    // Decoded as often as it changes (bounded), because a server behind a
    // proxy may decode once more than the parser did.
    for (let round = 0; round < 4; round += 1) {
      if (DOT_SEGMENT_RE.test(segment)) return false;
      if (/[\\/]/.test(segment) || /%(?:2f|5c)/i.test(segment)) return false;
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return false;
      }
      if (decoded === segment) break;
      segment = decoded;
    }
    if (segment === "" && i < segments.length - 1) return false;
  }
  return true;
}

/**
 * Whether `raw` is a URL the credential may be sent to: the exact extra URLs
 * given (the gateway's personal route), or the person's own database and
 * what lies under it. Decided on the parsed URL, never on a prefix of the text:
 * the same origin (scheme, host and port), no user information, a plain path
 * (`pathIsPlain`), and a normalised path that is the database's own or begins
 * with it followed by a `/` (so `user_abc2` is not under `user_abc`).
 */
function isAllowedUrl(
  raw: string,
  database: URL | null,
  extraUrls: readonly string[],
): boolean {
  if (extraUrls.includes(raw)) return true;
  if (!database) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.origin !== database.origin || url.origin === "null") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (!pathIsPlain(raw)) return false;
  const base = database.pathname.replace(/\/+$/, "");
  return (
    url.pathname === base ||
    url.pathname === `${base}/` ||
    url.pathname.startsWith(`${base}/`)
  );
}

function parseDatabaseUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.username === "" && url.password === "" && url.origin !== "null"
      ? url
      : null;
  } catch {
    return null;
  }
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

/** `POST .../_all_docs` asking for documents by key: the plugin's push check. */
function isDocLookup(url: string, init: RequestInit): boolean {
  if ((init.method ?? "GET").toUpperCase() !== "POST") return false;
  if (!url.split("?")[0].endsWith("/_all_docs")) return false;
  try {
    const body = JSON.parse(typeof init.body === "string" ? init.body : "") as {
      include_docs?: unknown;
      keys?: unknown;
    };
    return body.include_docs === true && Array.isArray(body.keys);
  } catch {
    return false;
  }
}

/** The most deleted documents one lookup reads back (a push batch is 50). */
const MAX_DELETED_READS = 50;

/**
 * Fill in the documents of the deleted ones.
 *
 * `_all_docs?include_docs=true` answers a deleted document with `doc: null`
 * (`value: {rev, deleted: true}`), and the plugin reads "no document" as "nothing
 * on the server, no conflict": it then writes its own revision over a deletion
 * made elsewhere whatever the times say, so the conflict rule (the later
 * `updatedAt` wins, and a tombstone has one) would never be asked. The deleted
 * revision's body (its common fields) is read with `GET <id>?rev=<rev>`, which
 * the gateway allows (`couch_proxy_policy.py`: a plain document, any query but
 * the denied ones), and put in `doc`, so the plugin sees the tombstone as the
 * master state it is. Best effort: a read that fails leaves `doc: null`, which
 * is what the plugin would have had.
 */
async function withDeletedDocs(
  response: Response,
  fetchDoc: CouchFetch,
  root: string,
): Promise<Response> {
  const text = await response.text();
  const keep = () =>
    new Response(text, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  let body: { rows?: unknown };
  try {
    body = JSON.parse(text) as { rows?: unknown };
  } catch {
    return keep();
  }
  if (!body || !Array.isArray(body.rows)) return keep();
  let reads = 0;
  let changed = false;
  for (const row of body.rows as Record<string, unknown>[]) {
    const value = row?.value as
      | { deleted?: unknown; rev?: unknown }
      | undefined;
    if (
      !row ||
      row.doc != null ||
      typeof row.id !== "string" ||
      !isOwnedDocId(row.id) ||
      value?.deleted !== true ||
      typeof value.rev !== "string" ||
      reads >= MAX_DELETED_READS
    ) {
      continue;
    }
    reads += 1;
    try {
      const got = await fetchDoc(
        `${root}${encodeURIComponent(row.id)}?rev=${encodeURIComponent(value.rev)}`,
      );
      const doc = (await got.json()) as Record<string, unknown> | null;
      if (doc && doc._deleted === true && doc._id === row.id) {
        row.doc = doc;
        changed = true;
      }
    } catch {
      // Leave it as the server answered; the plugin copes with "no document".
    }
  }
  return changed
    ? new Response(JSON.stringify(body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      })
    : keep();
}

export function createCouchFetch(options: CouchFetchOptions): CouchFetch {
  const plain = createPlainCouchFetch(options);
  const database = parseDatabaseUrl(options.databaseUrl);
  if (!database) return plain;
  const root = database.href.endsWith("/")
    ? database.href
    : `${database.href}/`;
  return async (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const response = await plain(input, init);
    return isDocLookup(url, init)
      ? withDeletedDocs(response, plain, root)
      : response;
  };
}

function createPlainCouchFetch(options: CouchFetchOptions): CouchFetch {
  const baseFetch = options.baseFetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? COUCH_REQUEST_TIMEOUT_MS;
  const extraUrls = options.extraUrls ?? [];
  const database = parseDatabaseUrl(options.databaseUrl);

  return async (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!isAllowedUrl(url, database, extraUrls)) {
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
