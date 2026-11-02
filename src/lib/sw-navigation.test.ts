import { describe, expect, it } from "vitest";
import {
  NAVIGATION_TIMEOUT_MS,
  PAGES_CACHE_PREFIX,
  SHELL_ANONYMOUS,
  SHELL_HEADER,
  classifyNavigation,
  handleNavigation,
  isShellResponse,
  pageKey,
  pagesCacheName,
  stalePagesCaches,
  versionOfManifest,
  type NavigationDeps,
  type PagesCache,
} from "./sw-navigation";

const ORIGIN = "https://weather.mukoko.com";
const url = (path: string) => new URL(path, ORIGIN);

function html(
  body: string,
  { shell = true, status = 200 }: { shell?: boolean; status?: number } = {},
) {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (shell) headers.set(SHELL_HEADER, SHELL_ANONYMOUS);
  return new Response(body, { status, headers });
}

class MemoryCache implements PagesCache {
  readonly store = new Map<string, Response>();
  async match(key: string) {
    return this.store.get(key)?.clone();
  }
  async put(key: string, res: Response) {
    this.store.set(key, res.clone());
  }
  async delete(key: string) {
    return this.store.delete(key);
  }
}

interface Harness {
  deps: NavigationDeps;
  pages: MemoryCache;
  background: Promise<unknown>[];
  calls: { network: number; offline: number; clear: number };
  settle(): Promise<void>;
  answers: { next: (() => Response | Promise<Response>) | "fail" };
}

function harness(next: Harness["answers"]["next"] = () => html("fresh")) {
  const pages = new MemoryCache();
  const background: Promise<unknown>[] = [];
  const calls = { network: 0, offline: 0, clear: 0 };
  const answers = { next };
  const deps: NavigationDeps = {
    pages,
    network: async () => {
      calls.network++;
      if (answers.next === "fail") throw new Error("offline");
      return answers.next();
    },
    offline: async () => {
      calls.offline++;
      return html("offline page", { shell: false });
    },
    clearPages: async () => {
      calls.clear++;
      pages.store.clear();
    },
    waitUntil: (p) => {
      background.push(p);
    },
    timeoutMs: 40,
  };
  return {
    deps,
    pages,
    background,
    calls,
    answers,
    settle: async () => {
      await Promise.all(background.splice(0));
    },
  } satisfies Harness;
}

describe("what may be a shell page", () => {
  it("classifies navigations", () => {
    expect(classifyNavigation(url("/"))).toBe("shell");
    expect(classifyNavigation(url("/harare"))).toBe("shell");
    expect(classifyNavigation(url("/harare/"))).toBe("shell");
    expect(classifyNavigation(url("/?utm_source=pwa"))).toBe("shell");
    expect(classifyNavigation(url("/callback?code=x"))).toBe("auth");
    expect(classifyNavigation(url("/auth/signin"))).toBe("auth");
    expect(classifyNavigation(url("/auth/signout"))).toBe("auth");
    // Never cached: signed-in or personal pages, sub-routes, other routes.
    for (const path of [
      "/profile",
      "/developers/keys",
      "/aviation",
      "/harare/forecast",
      "/explore",
      "/api/ai",
      "/api/devices",
      "/shamwari",
    ]) {
      expect(classifyNavigation(url(path)), path).toBe("other");
    }
  });

  it("keys a page by its path alone", () => {
    expect(pageKey(url("/harare?utm=1#top"))).toBe(`${ORIGIN}/harare`);
    expect(pageKey(url("/harare/"))).toBe(`${ORIGIN}/harare`);
    expect(pageKey(url("/"))).toBe(`${ORIGIN}/`);
  });

  it("only a 200 HTML page the server marked anonymous is kept", () => {
    expect(isShellResponse(html("x"))).toBe(true);
    expect(isShellResponse(html("x", { shell: false }))).toBe(false);
    expect(isShellResponse(html("x", { status: 404 }))).toBe(false);
    expect(isShellResponse(html("x", { status: 500 }))).toBe(false);
    expect(
      isShellResponse(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            [SHELL_HEADER]: SHELL_ANONYMOUS,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isShellResponse(
        new Response("x", {
          headers: {
            "content-type": "text/html",
            [SHELL_HEADER]: "signed-in",
          },
        }),
      ),
    ).toBe(false);
    expect(isShellResponse(Response.error())).toBe(false);
  });
});

describe("a place page: stale-while-revalidate", () => {
  it("the first open comes from the network and is stored for the next", async () => {
    const h = harness(() => html("first"));
    const res = await handleNavigation(url("/harare"), h.deps);
    expect(await res.text()).toBe("first");
    await h.settle();
    expect(h.calls.network).toBe(1);
    expect([...h.pages.store.keys()]).toEqual([`${ORIGIN}/harare`]);
  });

  it("the second open is the stored copy at once, and refreshes it in the background", async () => {
    const h = harness(() => html("v1"));
    await handleNavigation(url("/harare"), h.deps);
    await h.settle();

    let release!: (r: Response) => void;
    h.answers.next = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const second = await handleNavigation(url("/harare"), h.deps);
    // Painted from the copy while the network is still thinking.
    expect(await second.text()).toBe("v1");
    expect(h.calls.network).toBe(2);
    release(html("v2"));
    await h.settle();
    h.answers.next = () => html("v3");
    const third = await handleNavigation(url("/harare"), h.deps);
    expect(await third.text()).toBe("v2");
    await h.settle();
  });

  it("offline, a stored page still opens", async () => {
    const h = harness(() => html("v1"));
    await handleNavigation(url("/"), h.deps);
    await h.settle();
    h.answers.next = "fail";
    const res = await handleNavigation(url("/"), h.deps);
    expect(await res.text()).toBe("v1");
    await h.settle(); // the failed refresh is swallowed
    expect(h.calls.offline).toBe(0);
    expect(h.pages.store.size).toBe(1);
  });

  it("offline with nothing stored shows the offline shell", async () => {
    const h = harness("fail");
    const res = await handleNavigation(url("/nairobi-ke"), h.deps);
    expect(await res.text()).toBe("offline page");
    expect(h.calls.offline).toBe(1);
  });

  it("a network that never answers falls to the offline shell after the timeout", async () => {
    const h = harness(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const res = await handleNavigation(url("/nairobi-ke"), h.deps);
    expect(await res.text()).toBe("offline page");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(NAVIGATION_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("what is never stored", () => {
  it("a signed-in page (not marked anonymous) is returned but not stored", async () => {
    const h = harness(() => html("with the visitor's name", { shell: false }));
    const res = await handleNavigation(url("/harare"), h.deps);
    expect(await res.text()).toBe("with the visitor's name");
    await h.settle();
    expect(h.pages.store.size).toBe(0);
  });

  it("a 404, a redirect and an error page are not stored", async () => {
    for (const make of [
      () => html("nope", { status: 404 }),
      () => html("boom", { status: 500 }),
      () =>
        new Response(null, {
          status: 308,
          headers: { location: "/harare", [SHELL_HEADER]: SHELL_ANONYMOUS },
        }),
    ]) {
      const h = harness(make);
      await handleNavigation(url("/harare"), h.deps);
      await h.settle();
      expect(h.pages.store.size).toBe(0);
    }
  });

  it("personal and non-place pages go to the network every time and are never stored", async () => {
    for (const path of [
      "/profile",
      "/developers/keys",
      "/harare/forecast",
      "/explore",
      "/aviation",
    ]) {
      const h = harness(() => html("page"));
      await handleNavigation(url(path), h.deps);
      await handleNavigation(url(path), h.deps);
      await h.settle();
      expect(h.calls.network, path).toBe(2);
      expect(h.pages.store.size, path).toBe(0);
    }
  });

  it("falls back to the offline shell for a non-place page when the network fails", async () => {
    const h = harness("fail");
    const res = await handleNavigation(url("/explore"), h.deps);
    expect(await res.text()).toBe("offline page");
  });
});

describe("a stored copy never outlives its situation", () => {
  it("signing in or out drops every stored page, and the next page is fresh", async () => {
    const h = harness(() => html("anonymous"));
    await handleNavigation(url("/"), h.deps);
    await handleNavigation(url("/harare"), h.deps);
    await h.settle();
    expect(h.pages.store.size).toBe(2);

    h.answers.next = () => new Response(null, { status: 302 });
    await handleNavigation(url("/callback?code=abc"), h.deps);
    await h.settle();
    expect(h.calls.clear).toBe(1);
    expect(h.pages.store.size).toBe(0);

    await handleNavigation(url("/auth/signout"), h.deps);
    await h.settle();
    expect(h.calls.clear).toBe(2);
  });

  it("a refresh that finds the visitor signed in deletes the anonymous copy", async () => {
    const h = harness(() => html("anonymous"));
    await handleNavigation(url("/harare"), h.deps);
    await h.settle();
    h.answers.next = () => html("signed in", { shell: false });
    const second = await handleNavigation(url("/harare"), h.deps);
    expect(await second.text()).toBe("anonymous"); // one last stale paint
    await h.settle();
    expect(h.pages.store.size).toBe(0);
    // From now on: the network, with the visitor's own page.
    const third = await handleNavigation(url("/harare"), h.deps);
    expect(await third.text()).toBe("signed in");
  });

  it("a refresh that finds the place gone (404) or moved (redirect) deletes the copy", async () => {
    for (const make of [
      () => html("gone", { status: 404 }),
      () => new Response(null, { status: 308, headers: { location: "/x" } }),
    ]) {
      const h = harness(() => html("v1"));
      await handleNavigation(url("/harare"), h.deps);
      await h.settle();
      h.answers.next = make;
      await handleNavigation(url("/harare"), h.deps);
      await h.settle();
      expect(h.pages.store.size).toBe(0);
    }
  });

  it("a refresh that fails (5xx, offline) keeps the copy", async () => {
    const h = harness(() => html("v1"));
    await handleNavigation(url("/harare"), h.deps);
    await h.settle();
    h.answers.next = () => html("boom", { status: 503 });
    await handleNavigation(url("/harare"), h.deps);
    await h.settle();
    expect(h.pages.store.size).toBe(1);
  });

  it("never rejects, even when the cache itself throws", async () => {
    const h = harness(() => html("v1"));
    h.deps.pages = {
      match: async () => {
        throw new Error("quota");
      },
      put: async () => {
        throw new Error("quota");
      },
      delete: async () => {
        throw new Error("quota");
      },
    };
    const res = await handleNavigation(url("/harare"), h.deps);
    expect(await res.text()).toBe("v1");
    await h.settle();
  });
});

describe("versioned caches (a deploy never serves old HTML)", () => {
  it("names the cache by build version and lists every other build's caches as stale", () => {
    const current = pagesCacheName("abc");
    expect(current.startsWith(PAGES_CACHE_PREFIX)).toBe(true);
    expect(
      stalePagesCaches(
        [current, "pages-old", "pages-older", "static-assets", "weather-api"],
        "abc",
      ),
    ).toEqual(["pages-old", "pages-older"]);
  });

  it("the version changes when any emitted asset changes", () => {
    const a = versionOfManifest([
      { url: "/_next/static/chunks/a.js", revision: null },
      "/favicon.ico",
    ]);
    const b = versionOfManifest([
      { url: "/_next/static/chunks/b.js", revision: null },
      "/favicon.ico",
    ]);
    const a2 = versionOfManifest([
      { url: "/_next/static/chunks/a.js", revision: null },
      "/favicon.ico",
    ]);
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-z]+$/);
  });
});
