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
