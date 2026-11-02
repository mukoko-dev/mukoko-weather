/**
 * TEST SUPPORT, not shipped: an in-memory CouchDB behind the gateway's
 * replication rules, for the sync tests.
 *
 * It is as strict as the real thing where the real thing can refuse us:
 *
 *   - the request allow-list of nyuchi-api `gateway/lib/couch_proxy_policy.py`
 *     (ported here: which paths, which methods, which query parameters, the
 *     clamps, no continuous feed, `_bulk_docs` body keys), so a request the
 *     gateway would turn away is a 4xx here;
 *   - the bearer must be the one the test issued (401 otherwise);
 *   - every write runs the pinned `validate_doc_update` function of
 *     `gateway/lib/couch_validate_personal.js` (`__fixtures__/`), with the
 *     person as `userCtx.name` and the only member of the security document;
 *   - revisions: a write over a live document needs its `_rev` (conflict
 *     otherwise); a tombstone keeps only its stub; `_deleted: false` is not
 *     stored, as in CouchDB.
 *
 * It is NOT a CouchDB: no views, no attachments, a single revision counter
 * per document. Nothing here proves behaviour of the live server.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

type Json = Record<string, unknown>;

interface Stored {
  seq: number;
  rev: string;
  deleted: boolean;
  /** The body without `_id`/`_rev`; null for a tombstone. */
  body: Json | null;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
  body: unknown;
  status: number;
}

const DENIED_PARAMS = new Set([
  "view",
  "style_not",
  "purge",
  "rev_limit",
  "w",
  "q",
  "n",
]);
const CHANGES_LIMIT_MAX = 1000;

type Validator = (
  newDoc: Json,
  oldDoc: Json | null,
  userCtx: { name: string | null; roles: string[] },
  secObj: { members: { names: string[] } },
) => void;

function loadValidator(): Validator {
  const source = readFileSync(
    join(__dirname, "..", "__fixtures__", "couch_validate_personal.fn.txt"),
    "utf8",
  );
  // The pinned fixture is one function expression (a repo file, never input).
  return runInNewContext(`(${source})`) as Validator;
}

interface Decision {
  allowed: boolean;
  kind?: string;
  status?: number;
  reason?: string;
}

/** Port of `couch_proxy_policy.classify`, for the paths a database root sees. */
export function classify(method: string, path: string): Decision {
  const parts = path ? path.split("/") : [];
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    return { allowed: false, status: 400, reason: "bad_path" };
  }
  if (parts.length === 0) {
    return method === "GET" || method === "HEAD"
      ? { allowed: true, kind: "info" }
      : { allowed: false, status: 405, reason: "database_level_writes" };
  }
  const first = parts[0];
  if (first === "_local" && parts.length === 2) {
    return { allowed: true, kind: "document" };
  }
  if (first.startsWith("_")) {
    if (parts.length !== 1) {
      return { allowed: false, status: 403, reason: "endpoint_not_allowed" };
    }
    if (first === "_changes" && (method === "GET" || method === "POST")) {
      return { allowed: true, kind: "changes" };
    }
    if (first === "_all_docs" && (method === "GET" || method === "POST")) {
      return { allowed: true, kind: "all_docs" };
    }
    if (
      ["_bulk_get", "_revs_diff", "_ensure_full_commit"].includes(first) &&
      method === "POST"
    ) {
      return { allowed: true, kind: "other_json" };
    }
    if (first === "_bulk_docs" && method === "POST") {
      return { allowed: true, kind: "bulk_docs" };
    }
    return { allowed: false, status: 403, reason: "endpoint_not_allowed" };
  }
  return {
    allowed: true,
    kind: parts.length === 1 ? "document" : "attachment",
  };
}

/** Port of `couch_proxy_policy.check_query`: the query, or a reason to refuse. */
export function checkQuery(
  kind: string,
  params: [string, string][],
): { query: [string, string][]; reason?: string } {
  const out: [string, string][] = [];
  for (const [key, rawValue] of params) {
    let value = rawValue;
    const low = key.toLowerCase();
    if (DENIED_PARAMS.has(low))
      return { query: [], reason: `parameter_not_allowed:${low}` };
    if (low === "feed" && kind === "changes") {
      if (value !== "normal" && value !== "longpoll") {
        return { query: [], reason: "feed_not_allowed" };
      }
    } else if (low === "filter") {
      if (kind !== "changes" || !["_doc_ids", "_selector"].includes(value)) {
        return { query: [], reason: "filter_not_allowed" };
      }
    } else if (low === "timeout" && kind === "changes") {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n)) return { query: [], reason: "bad_timeout" };
      value = String(Math.min(Math.max(n, 0), 25_000));
    } else if (low === "limit" && (kind === "changes" || kind === "all_docs")) {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n)) return { query: [], reason: "bad_limit" };
      value = String(Math.min(Math.max(n, 0), CHANGES_LIMIT_MAX));
    } else if (low === "heartbeat") {
      continue;
    }
    out.push([key, value]);
  }
  return { query: out };
}

export interface FakeCouchOptions {
  personId: string;
  /** The bearer the gateway accepts (the person's sign-in token). */
  token: string;
}

export class FakeCouch {
  readonly calls: RecordedCall[] = [];
  /** Make the next N requests fail with this status (0 = network error). */
  failNext: { status: number; count: number } | null = null;
  /** Set to change the accepted bearer (a rotated or revoked credential). */
  token: string;
  readonly personId: string;
  private readonly docs = new Map<string, Stored>();
  private seq = 0;
  private revCounter = 0;
  private readonly validate = loadValidator();

  constructor(options: FakeCouchOptions) {
    this.personId = options.personId;
    this.token = options.token;
  }

  /** A document as CouchDB would return it, or undefined. */
  get(id: string): Json | undefined {
    const s = this.docs.get(id);
    if (!s) return undefined;
    return s.deleted
      ? { _id: id, _rev: s.rev, _deleted: true }
      : { _id: id, _rev: s.rev, ...s.body };
  }

  liveIds(): string[] {
    return [...this.docs.entries()]
      .filter(([, s]) => !s.deleted)
      .map(([id]) => id);
  }

  /** Write a document directly, as another device would have (validated). */
  seed(doc: Json): { ok: boolean; reason?: string } {
    const res = this.writeOne({ ...doc });
    return res.ok ? { ok: true } : { ok: false, reason: String(res.reason) };
  }

  /** `fetch`-shaped entry point for the replication plugin. */
  fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const marker = `/v1/couch/db/user_${this.personId}`;
    const idx = url.pathname.indexOf(marker);
    const path =
      idx < 0 ? "" : url.pathname.slice(idx + marker.length).replace(/^\//, "");
    const body = init?.body
      ? (JSON.parse(String(init.body)) as unknown)
      : undefined;

    const respond = (status: number, payload: unknown): Response => {
      this.calls.push({
        method,
        path,
        query: url.search,
        authorization: auth,
        body,
        status,
      });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    };

    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count -= 1;
      const { status } = this.failNext;
      if (status === 0) {
        this.calls.push({
          method,
          path,
          query: url.search,
          authorization: auth,
          body,
          status: 0,
        });
        throw new TypeError("network error");
      }
      return respond(status, { error: "injected" });
    }
    if (idx < 0) return respond(404, { detail: "No such database." });
    if (auth !== `Bearer ${this.token}`)
      return respond(401, { detail: "Invalid or expired token" });

    const decision = classify(method, path);
    if (!decision.allowed) {
      return respond(decision.status ?? 403, {
        detail: `Not allowed: ${decision.reason}`,
      });
    }
    const q = checkQuery(decision.kind ?? "", [...url.searchParams.entries()]);
    if (q.reason) return respond(400, { detail: `Not allowed: ${q.reason}` });
    if (decision.kind === "bulk_docs") {
      const b = body as Json | undefined;
      const extra = b
        ? Object.keys(b).filter((k) => k !== "docs" && k !== "new_edits")
        : [];
      if (!b || !Array.isArray(b.docs) || extra.length > 0) {
        return respond(400, { detail: "Not allowed: body_not_allowed" });
      }
    }

    const params = new Map(q.query);
    switch (path) {
      case "_changes":
        return respond(200, this.changes(params));
      case "_all_docs":
        return respond(
          200,
          this.allDocs(method, params, body as Json | undefined),
        );
      case "_bulk_docs":
        return respond(201, this.bulkDocs((body as Json).docs as Json[]));
      case "":
        return respond(200, { db_name: `user_${this.personId}` });
      default:
        return respond(404, { error: "not_found" });
    }
  };

  // -- CouchDB behaviour ----------------------------------------------------

  private changes(params: Map<string, string>): Json {
    const since = Number(params.get("since") ?? 0) || 0;
    const limit = Number(params.get("limit") ?? CHANGES_LIMIT_MAX);
    const includeDocs = params.get("include_docs") === "true";
    const rows = [...this.docs.entries()]
      .filter(([, s]) => s.seq > since)
      .sort((a, b) => a[1].seq - b[1].seq)
      .slice(0, limit);
    const results = rows.map(([id, s]) => {
      const row: Json = { seq: s.seq, id, changes: [{ rev: s.rev }] };
      if (s.deleted) row.deleted = true;
      if (includeDocs) row.doc = this.get(id);
      return row;
    });
    const last =
      rows.length > 0 ? rows[rows.length - 1][1].seq : since || this.seq;
    return { results, last_seq: last, pending: 0 };
  }

  private allDocs(
    method: string,
    params: Map<string, string>,
    body: Json | undefined,
  ): Json {
    const keys: string[] =
      method === "POST"
        ? ((body?.keys as string[]) ?? [])
        : (JSON.parse(params.get("keys") ?? "[]") as string[]);
    const includeDocs =
      method === "POST"
        ? body?.include_docs === true
        : params.get("include_docs") === "true";
    const rows = keys.map((key) => {
      const s = this.docs.get(key);
      if (!s) return { key, error: "not_found" };
      if (s.deleted)
        return {
          id: key,
          key,
          value: { rev: s.rev, deleted: true },
          doc: null,
        };
      const row: Json = { id: key, key, value: { rev: s.rev } };
      if (includeDocs) row.doc = this.get(key);
      return row;
    });
    return { total_rows: this.docs.size, offset: 0, rows };
  }

  private bulkDocs(docs: Json[]): Json[] {
    return docs.map((doc) => {
      const res = this.writeOne(doc);
      return res.ok
        ? { ok: true, id: doc._id, rev: res.rev }
        : { id: doc._id, error: res.error, reason: res.reason };
    });
  }

  private writeOne(
    doc: Json,
  ): { ok: true; rev: string } | { ok: false; error: string; reason: string } {
    const id = String(doc._id);
    const existing = this.docs.get(id);
    const sent = doc._rev as string | undefined;

    const old =
      existing && !existing.deleted
        ? { _id: id, _rev: existing.rev, ...existing.body }
        : null;
    // CouchDB: a write over a live document needs its current revision; over a
    // tombstone it may omit it.
    if (existing && !existing.deleted && sent !== existing.rev) {
      return {
        ok: false,
        error: "conflict",
        reason: "Document update conflict.",
      };
    }
    if (
      existing &&
      existing.deleted &&
      sent !== undefined &&
      sent !== existing.rev
    ) {
      return {
        ok: false,
        error: "conflict",
        reason: "Document update conflict.",
      };
    }

    const incoming: Json = { ...doc };
    if (incoming._deleted === false) delete incoming._deleted;
    try {
      this.validate(
        incoming,
        old,
        { name: this.personId, roles: [] },
        { members: { names: [this.personId] } },
      );
    } catch (err) {
      const reason = (err as { forbidden?: string }).forbidden;
      if (reason !== undefined)
        return { ok: false, error: "forbidden", reason };
      throw err;
    }

    this.revCounter += 1;
    const gen = existing ? Number(existing.rev.split("-")[0]) + 1 : 1;
    const rev = `${gen}-${String(this.revCounter).padStart(32, "0")}`;
    this.seq += 1;
    if (incoming._deleted === true) {
      this.docs.set(id, { seq: this.seq, rev, deleted: true, body: null });
    } else {
      const body: Json = { ...incoming };
      delete body._id;
      delete body._rev;
      this.docs.set(id, { seq: this.seq, rev, deleted: false, body });
    }
    return { ok: true, rev };
  }
}
