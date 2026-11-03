import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ACTIVITIES } from "../activities";
import { isOwnedDocId, ownedDocIds } from "./couch-docs";
import { CouchHttpError, createCouchFetch, filterChanges } from "./couch-fetch";

const DB = "https://api.test/v1/couch/db/user_abc/";
const TOKEN = "secret-token-value-0123456789";

function transport(
  handler: (req: { url: string; init: RequestInit }) => Response,
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler({ url: String(input), init: init ?? {} }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("requests", () => {
  it("sends the bearer, omits cookies and never follows a redirect", async () => {
    const base = transport(() => json({ ok: true }));
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: base,
    });
    await f(`${DB}_all_docs`, { method: "POST", body: "{}" });
    const init = (base as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
  });

  it("refuses a URL outside the database and sends nothing", async () => {
    const base = transport(() => json({}));
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: base,
    });
    await expect(f("https://evil.test/steal")).rejects.toBeInstanceOf(
      CouchHttpError,
    );
    await expect(
      f("https://api.test/v1/couch/db/user_other/_changes"),
    ).rejects.toBeInstanceOf(CouchHttpError);
    expect(base).not.toHaveBeenCalled();
  });

  it("without a token it is a 401 and nothing is sent", async () => {
    const base = transport(() => json({}));
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => null,
      baseFetch: base,
    });
    await expect(f(`${DB}_changes`)).rejects.toMatchObject({ status: 401 });
    expect(base).not.toHaveBeenCalled();
  });
});

// The credential is sent to the person's own database and to nothing else. The
// check parses the URL (a prefix test on the text is fooled by every URL trick
// there is): same origin, no user information, no dot segment however it is
// written, no backslash, and a path that is the database's or lies under it.
describe("the URL guard: the credential goes to the person's own database only", () => {
  const PERSONAL = "https://api.test/v1/couch/personal";
  const make = () => {
    // Also a valid (empty) changes feed, for the feed URLs.
    const base = transport(() => json({ ok: true, results: [], last_seq: 0 }));
    const f = createCouchFetch({
      databaseUrl: DB,
      extraUrls: [PERSONAL],
      getToken: () => TOKEN,
      baseFetch: base,
    });
    return { base, f };
  };

  it.each([
    ["the database itself", DB],
    ["the changes feed with a query", `${DB}_changes?since=0&limit=200`],
    ["all docs", `${DB}_all_docs`],
    ["bulk docs", `${DB}_bulk_docs`],
    ["a document by id, encoded", `${DB}activity%3Alivestock`],
    ["a deleted revision", `${DB}activity%3Alivestock?rev=2-abcdef`],
    ["a local checkpoint document", `${DB}_local/abc123`],
  ])("allows %s", async (_name, url) => {
    const { base, f } = make();
    await expect(f(url)).resolves.toBeInstanceOf(Response);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("allows the exact personal route, and only that", async () => {
    const { base, f } = make();
    await expect(f(PERSONAL, { method: "POST" })).resolves.toBeInstanceOf(
      Response,
    );
    expect(base).toHaveBeenCalledTimes(1);
    for (const url of [
      `${PERSONAL}/`,
      `${PERSONAL}?x=1`,
      `${PERSONAL}/../x`,
      `${PERSONAL}2`,
    ]) {
      await expect(f(url), url).rejects.toMatchObject({ status: 0 });
    }
    expect(base).toHaveBeenCalledTimes(1);
  });

  it.each([
    // dot segments, as written
    ["a dot-dot segment", `${DB}../user_other/_changes`],
    ["a dot-dot after a segment", `${DB}_changes/../../user_other/_changes`],
    ["a single dot segment", `${DB}./_changes`],
    // ...and as the URL parser also reads them (percent-encoded dots)
    ["an encoded dot-dot", `${DB}%2e%2e/user_other/_changes`],
    ["an upper-case encoded dot-dot", `${DB}%2E%2E/user_other/_changes`],
    ["a half-encoded dot-dot", `${DB}.%2e/user_other/_changes`],
    ["the other half-encoded dot-dot", `${DB}%2e./user_other/_changes`],
    ["an encoded single dot", `${DB}%2e/_changes`],
    ["a double-encoded dot-dot", `${DB}%252e%252e/user_other/_changes`],
    // separators in disguise
    ["an encoded slash", `${DB}..%2fuser_other%2f_changes`],
    ["a backslash", `${DB}_changes\\..\\..\\user_other`],
    ["an encoded backslash", `${DB}%5c..%5cuser_other`],
    ["an empty segment", `https://api.test/v1/couch/db/user_abc//_changes`],
    // another database that merely starts with the same text
    [
      "a lookalike prefix (user_abc2)",
      "https://api.test/v1/couch/db/user_abc2/_changes",
    ],
    [
      "a lookalike prefix (user_abc-x)",
      "https://api.test/v1/couch/db/user_abc-x/_all_docs",
    ],
    ["a sibling database", "https://api.test/v1/couch/db/user_other/_changes"],
    ["the parent path", "https://api.test/v1/couch/db/"],
    ["a database-less path", "https://api.test/v1/couch/db"],
    // another origin
    ["another host", "https://evil.test/v1/couch/db/user_abc/_changes"],
    [
      "a host that starts with ours",
      "https://api.test.evil.test/v1/couch/db/user_abc/_changes",
    ],
    ["another port", "https://api.test:8443/v1/couch/db/user_abc/_changes"],
    ["another scheme", "http://api.test/v1/couch/db/user_abc/_changes"],
    // user information
    [
      "user information naming another host",
      "https://api.test@evil.test/v1/couch/db/user_abc/_changes",
    ],
    [
      "user information on our host",
      "https://user:pw@api.test/v1/couch/db/user_abc/_changes",
    ],
    ["a user name only", "https://user@api.test/v1/couch/db/user_abc/_changes"],
    [
      "an at sign in the path",
      "https://api.test/v1/couch/db/user_abc/@evil.test/_changes",
    ],
    // not a URL at all
    ["a relative path", "/v1/couch/db/user_abc/_changes"],
    ["an empty string", ""],
    ["nonsense", "not a url"],
  ])("refuses %s and sends nothing", async (_name, url) => {
    const { base, f } = make();
    await expect(f(url), url).rejects.toBeInstanceOf(CouchHttpError);
    await expect(f(url), url).rejects.toMatchObject({ status: 0 });
    expect(base).not.toHaveBeenCalled();
  });

  it("works the same when the database URL is given without its trailing slash", async () => {
    const base = transport(() => json({ results: [], last_seq: 0 }));
    const f = createCouchFetch({
      databaseUrl: "https://api.test/v1/couch/db/user_abc",
      getToken: () => TOKEN,
      baseFetch: base,
    });
    await f("https://api.test/v1/couch/db/user_abc/_changes");
    await f("https://api.test/v1/couch/db/user_abc");
    expect(base).toHaveBeenCalledTimes(2);
    await expect(
      f("https://api.test/v1/couch/db/user_abc2/_changes"),
    ).rejects.toMatchObject({ status: 0 });
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("an unreadable database URL allows nothing but the exact extra URLs", async () => {
    const base = transport(() => json({}));
    const f = createCouchFetch({
      databaseUrl: "not a url",
      extraUrls: [PERSONAL],
      getToken: () => TOKEN,
      baseFetch: base,
    });
    await expect(f(`${DB}_changes`)).rejects.toMatchObject({ status: 0 });
    await expect(f(PERSONAL, { method: "POST" })).resolves.toBeInstanceOf(
      Response,
    );
  });

  it("the token is not in the error of a refused request", async () => {
    const { f } = make();
    const err = await f("https://evil.test/steal").catch((e: Error) => e);
    expect(String(err)).not.toContain(TOKEN);
    expect(String(err)).not.toContain("evil.test");
  });
});

// The plugin's push check reads `_all_docs?include_docs` and takes a row with
// no `doc` for "nothing on the server", so a deletion made elsewhere would be
// written over whatever the times say. The deleted revision is read back.
describe("a deleted document's body is read back for the push check", () => {
  const TOMBSTONE = {
    _id: "activity:gardening",
    _rev: "2-bbbb",
    _deleted: true,
    type: "activity",
    updatedAt: "2026-11-02T10:00:09.000Z",
  };
  const lookup = (keys: string[]) => ({
    method: "POST",
    body: JSON.stringify({ keys, include_docs: true, deleted: "ok" }),
  });
  const deletedRow = (id: string, rev = "2-bbbb") => ({
    id,
    key: id,
    value: { rev, deleted: true },
    doc: null,
  });

  function setup(docAnswer: () => Response) {
    const seen: { url: string; method: string }[] = [];
    const base = transport(({ url, init }) => {
      seen.push({ url, method: init.method ?? "GET" });
      return url.includes("_all_docs")
        ? json({
            total_rows: 2,
            offset: 0,
            rows: [
              deletedRow("activity:gardening"),
              {
                id: "preference:theme",
                key: "preference:theme",
                value: { rev: "1-a" },
                doc: { _id: "preference:theme", _rev: "1-a" },
              },
              { key: "activity:never", error: "not_found" },
            ],
          })
        : docAnswer();
    });
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: base,
    });
    return { f, seen };
  }

  it("puts the tombstone in the row, asked for by id and revision", async () => {
    const { f, seen } = setup(() => json(TOMBSTONE));
    const res = await f(`${DB}_all_docs`, lookup(["activity:gardening"]));
    const rows = (await res.json()).rows;
    expect(rows[0].doc).toEqual(TOMBSTONE);
    // The live document and the missing key are as the server answered.
    expect(rows[1].doc).toEqual({ _id: "preference:theme", _rev: "1-a" });
    expect(rows[2].doc).toBeUndefined();
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST ${DB}_all_docs`,
      `GET ${DB}activity%3Agardening?rev=2-bbbb`,
    ]);
  });

  it("a read that fails leaves the row as the server answered it", async () => {
    for (const answer of [
      () => json({ error: "not_found" }, 404),
      () => json({ error: "x" }, 500),
      () => json(null),
      () => json({ _id: "other", _deleted: true }),
      () => json({ _id: "activity:gardening", _rev: "2-bbbb" }), // not deleted
    ]) {
      const { f } = setup(answer);
      const res = await f(`${DB}_all_docs`, lookup(["activity:gardening"]));
      expect((await res.json()).rows[0].doc).toBeNull();
    }
  });

  it("a request that is not a lookup of documents by key is passed on untouched", async () => {
    const { f, seen } = setup(() => json(TOMBSTONE));
    // No include_docs, a GET, and another path: none reads a deleted body.
    await f(`${DB}_all_docs`, {
      method: "POST",
      body: JSON.stringify({ keys: ["activity:gardening"] }),
    });
    await f(`${DB}_all_docs`);
    await f(`${DB}_bulk_docs`, lookup(["activity:gardening"]));
    expect(seen.filter((s) => s.method === "GET")).toHaveLength(1); // the plain GET itself
    expect(seen.some((s) => s.url.includes("?rev="))).toBe(false);
  });

  it("only ids this client owns are read back", async () => {
    const base = transport(({ url }) =>
      url.includes("_all_docs")
        ? json({
            rows: [
              deletedRow("savedPlace:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"),
            ],
          })
        : json(TOMBSTONE),
    );
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: base,
    });
    const res = await f(
      `${DB}_all_docs`,
      lookup(["savedPlace:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"]),
    );
    expect((await res.json()).rows[0].doc).toBeNull();
    expect(base).toHaveBeenCalledTimes(1);
  });
});

describe("a signal from the caller", () => {
  it("aborts the request that is in flight, as 'no answer'", async () => {
    let aborted = false;
    const base = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;
    const caller = new AbortController();
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: base,
      signal: caller.signal,
    });
    const pending = f(`${DB}_all_docs`, { method: "POST", body: "{}" });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ status: 0 });
    expect(aborted).toBe(true);
  });

  it("a request made after the signal fired is not sent", async () => {
    const base = transport(() => json({}));
    const caller = new AbortController();
    caller.abort();
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: base,
      signal: caller.signal,
    });
    await expect(f(`${DB}_all_docs`)).rejects.toMatchObject({ status: 0 });
    expect(base).not.toHaveBeenCalled();
  });
});

describe("answers", () => {
  it("a non-2xx answer is a CouchHttpError with its status", async () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const f = createCouchFetch({
        databaseUrl: DB,
        getToken: () => TOKEN,
        baseFetch: transport(() => json({ detail: "x" }, status)),
      });
      await expect(f(`${DB}_changes`)).rejects.toMatchObject({ status });
    }
  });

  it("no answer at all (offline, CORS, abort) is status 0", async () => {
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    await expect(f(`${DB}_changes`)).rejects.toMatchObject({ status: 0 });
  });

  it("a hung request ends at the timeout", async () => {
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      timeoutMs: 20,
      baseFetch: ((_url: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("abort")));
        })) as never,
    });
    await expect(f(`${DB}_changes`)).rejects.toMatchObject({ status: 0 });
  });

  it("an error never carries the token or the URL", async () => {
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: transport(() => json({ detail: TOKEN }, 500)),
    });
    try {
      await f(`${DB}_changes?since=1`);
      expect.unreachable();
    } catch (err) {
      const text = `${(err as Error).message} ${(err as Error).stack}`;
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("api.test");
    }
  });
});

describe("_changes filtering", () => {
  const feed = {
    last_seq: "9-abc",
    pending: 0,
    results: [
      { id: "activity:livestock", doc: { _id: "activity:livestock" } },
      { id: "preference:theme", doc: {} },
      { id: "preference:homePlace", doc: {} },
      { id: "savedPlace:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", doc: {} },
      { id: "_design/nyuchi", doc: {} },
      {
        id: "activity:gone",
        deleted: true,
        doc: { _id: "activity:gone", _deleted: true },
      },
    ],
  };

  it("keeps only owned ids and the checkpoint", () => {
    const out = filterChanges(feed) as {
      results: { id: string }[];
      last_seq: string;
    };
    expect(out.results.map((r) => r.id)).toEqual([
      "activity:livestock",
      "preference:theme",
      "activity:gone",
    ]);
    expect(out.last_seq).toBe("9-abc");
  });

  it("is applied to a changes feed through the fetch, and only to that", async () => {
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: transport(() => json(feed)),
    });
    const res = await f(`${DB}_changes?feed=normal`);
    const body = (await res.json()) as { results: { id: string }[] };
    expect(body.results).toHaveLength(3);

    const other = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: transport(() => json({ rows: feed.results })),
    });
    const all = await other(`${DB}_all_docs`, { method: "POST", body: "{}" });
    expect(((await all.json()) as { rows: unknown[] }).rows).toHaveLength(6);
  });

  it("a malformed feed is a 502, not an empty success", () => {
    expect(() => filterChanges(null)).toThrow(CouchHttpError);
    expect(() => filterChanges({ last_seq: 1 })).toThrow(CouchHttpError);
    expect(() => filterChanges({ results: "nope" })).toThrow(CouchHttpError);
  });
});

// RxDB stops a pull WITHOUT saving its checkpoint when a page has no documents,
// and counts a page with fewer than its batch size as the end of the feed. So
// rows dropped here, after the server sent them, could leave the next cycle on
// the same `since` for ever, or end every cycle after one page. The server is
// therefore asked for this client's ids only (`filter=_doc_ids`), and rows that
// are not ours never fill a page.
describe("_changes asks for this client's documents only", () => {
  const LIMIT = 200;
  const ask = (query = "style=all_docs&feed=normal&include_docs=true") =>
    `${DB}_changes?${query}&since=17-g1AAA&limit=${LIMIT}&seq_interval=${LIMIT}`;

  function server(reply: (req: { url: URL; init: RequestInit }) => unknown) {
    const seen: { url: URL; init: RequestInit }[] = [];
    const base = transport(({ url, init }) => {
      const req = { url: new URL(url), init };
      seen.push(req);
      return json(reply(req));
    });
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: base,
    });
    return { f, seen };
  }

  it("the plugin's GET becomes a POST with the filter and the ids, and nothing else about the request changes", async () => {
    const { f, seen } = server(() => ({ results: [], last_seq: "17-g1AAA" }));
    await f(ask(), { method: "GET" });
    const [req] = seen;
    expect(req.init.method).toBe("POST");
    const params = req.url.searchParams;
    expect(params.get("filter")).toBe("_doc_ids");
    // The plugin's own parameters are all still there, as it sent them.
    expect(params.get("since")).toBe("17-g1AAA");
    expect(params.get("limit")).toBe(String(LIMIT));
    expect(params.get("include_docs")).toBe("true");
    expect(params.get("feed")).toBe("normal");
    expect(params.get("seq_interval")).toBe(String(LIMIT));
    const headers = new Headers(req.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(req.init.credentials).toBe("omit");
    expect(req.init.redirect).toBe("error");
    expect(Object.keys(JSON.parse(String(req.init.body)))).toEqual(["doc_ids"]);
  });

  it("the ids are the ones this client owns: both settings and every activity the app offers, no more", async () => {
    const { f, seen } = server(() => ({ results: [], last_seq: "1" }));
    await f(ask());
    const ids = JSON.parse(String(seen[0].init.body)).doc_ids as string[];
    expect(ids).toEqual(ownedDocIds());
    expect(ids).toContain("preference:theme");
    expect(ids).toContain("preference:forecastModel");
    expect(ids).toContain("activity:livestock");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => isOwnedDocId(id))).toBe(true);
    // Bounded by the app's own vocabulary, nowhere near a feed.
    expect(ids.length).toBeLessThanOrEqual(100);
    expect(ids.length).toBe(2 + ACTIVITIES.length);
  });

  it("the same request however long the feed is, and a page of rows that match is passed on whole", async () => {
    const rows = Array.from({ length: LIMIT }, (_, i) => ({
      id: i % 2 ? "preference:theme" : "activity:livestock",
      seq: `${i}-x`,
      doc: {},
    }));
    const { f, seen } = server(() => ({ results: rows, last_seq: "200-x" }));
    const res = await f(ask());
    const body = (await res.json()) as { results: unknown[]; last_seq: string };
    expect(body.results).toHaveLength(LIMIT);
    expect(body.last_seq).toBe("200-x");
    expect(seen).toHaveLength(1); // one request, no paging loop here
  });

  it("an empty answer passes through with its checkpoint (nothing new)", async () => {
    const { f } = server(() => ({ results: [], last_seq: "99-end" }));
    const res = await f(ask());
    expect(await res.json()).toEqual({ results: [], last_seq: "99-end" });
  });

  it("rows that are not this client's are dropped when the server sent some anyway, and the rest are kept", async () => {
    const { f } = server(() => ({
      results: [
        { id: "interest:x", doc: {} },
        { id: "preference:theme", doc: {} },
      ],
      last_seq: "5-y",
    }));
    const body = (await (await f(ask())).json()) as {
      results: { id: string }[];
    };
    expect(body.results.map((r) => r.id)).toEqual(["preference:theme"]);
  });

  it("a page that was ALL foreign although the server was asked for ours only is a 502: a filter that was ignored must not look like an empty feed (RxDB would not move its checkpoint)", async () => {
    const { f } = server(() => ({
      results: [
        { id: "interest:x", doc: {} },
        { id: "savedPlace:y", doc: {} },
      ],
      last_seq: "2-z",
    }));
    await expect(f(ask())).rejects.toMatchObject({ status: 502 });
  });

  it("only the changes feed is rewritten: documents and bulk requests go as the plugin sent them", async () => {
    const { f, seen } = server(() => ({ rows: [], ok: true }));
    await f(`${DB}_all_docs?include_docs=true`, {
      method: "POST",
      body: JSON.stringify({ keys: ["preference:theme"] }),
    });
    await f(`${DB}_bulk_docs`, { method: "POST", body: '{"docs":[]}' });
    expect(seen[0].url.searchParams.get("filter")).toBeNull();
    expect(seen[0].init.body).toBe('{"keys":["preference:theme"]}');
    expect(seen[1].init.body).toBe('{"docs":[]}');
  });

  it("a filter already in the request is replaced by this one, never doubled", async () => {
    const { f, seen } = server(() => ({ results: [], last_seq: "1" }));
    await f(ask("feed=normal&filter=_selector"));
    expect(seen[0].url.searchParams.getAll("filter")).toEqual(["_doc_ids"]);
  });
});

describe("one request, one timeout (the helper every caller of this layer shares)", () => {
  it("a response whose BODY never arrives is cut off by the timeout too, not only one whose headers never do", async () => {
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      timeoutMs: 20,
      baseFetch: (async (_url: string, init?: RequestInit) => {
        const res = new Response(null, { status: 200 });
        res.text = () =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        return res;
      }) as never,
    });
    await expect(f(`${DB}_all_docs`, { method: "POST" })).rejects.toMatchObject(
      { status: 502 },
    );
  });

  it("the body that comes back is the one the server sent, readable by the caller (the plugin reads it with .json())", async () => {
    const f = createCouchFetch({
      databaseUrl: DB,
      getToken: () => TOKEN,
      baseFetch: transport(() => json({ ok: true, rows: [1, 2] }, 201)),
    });
    const res = await f(`${DB}_bulk_docs`, { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, rows: [1, 2] });
  });

  it("a request for exactly one more URL is allowed (the gateway's personal route), and nothing near it", async () => {
    const PERSONAL = "https://api.test/v1/couch/personal";
    const base = transport(() => json({ ready: true }));
    const f = createCouchFetch({
      databaseUrl: DB,
      extraUrls: [PERSONAL],
      getToken: () => TOKEN,
      baseFetch: base,
    });
    await f(PERSONAL, { method: "POST" });
    expect(base).toHaveBeenCalledTimes(1);
    for (const url of [
      `${PERSONAL}/../x`,
      `${PERSONAL}?x=1`,
      "https://api.test/v1/couch/session",
      "https://evil.test/v1/couch/personal",
    ]) {
      await expect(f(url, { method: "POST" })).rejects.toMatchObject({
        status: 0,
      });
    }
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("the timeout/abort/'no answer' plumbing is written once: one AbortController in the whole sync transport, none in the session client", () => {
    const here = readFileSync(`${__dirname}/couch-fetch.ts`, "utf8");
    const session = readFileSync(`${__dirname}/couch-session.ts`, "utf8");
    expect(here.match(/new AbortController\(/g) ?? []).toHaveLength(1);
    expect(session.match(/new AbortController\(/g) ?? []).toHaveLength(0);
    expect(session.match(/\bsetTimeout\(/g) ?? []).toHaveLength(0);
  });
});
