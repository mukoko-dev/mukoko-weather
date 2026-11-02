import { describe, expect, it, vi } from "vitest";
import {
  CouchHttpError,
  createCouchFetch,
  filterChanges,
} from "./couch-fetch";

const DB = "https://api.test/v1/couch/db/user_abc/";
const TOKEN = "secret-token-value-0123456789";

function transport(handler: (req: { url: string; init: RequestInit }) => Response) {
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
      { id: "activity:gone", deleted: true, doc: { _id: "activity:gone", _deleted: true } },
    ],
  };

  it("keeps only owned ids and the checkpoint", () => {
    const out = filterChanges(feed) as { results: { id: string }[]; last_seq: string };
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
