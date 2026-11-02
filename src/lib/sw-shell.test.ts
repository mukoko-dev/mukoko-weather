import { describe, expect, it, vi } from "vitest";
import {
  MAX_SHELL_ASSETS,
  MAX_SHELL_HTML_CHARS,
  SHELL_RETRY_GAP_MS,
  boundedBy,
  createShellKeeper,
  isStorableStaticAsset,
  shellAssetUrls,
  warmShellAssets,
  type ShellWarmResult,
} from "./sw-shell";

const PAGE = "https://weather.mukoko.com/offline";

/** The shapes the real /offline document carries (Next 16, App Router). */
const OFFLINE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>
<link rel="stylesheet" href="/_next/static/css/117c5568da8487e0.css" data-precedence="next"/>
<link rel="stylesheet" href="/_next/static/css/e075b83ea2a5a058.css" data-precedence="next"/>
<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/webpack-b7c79fce3aebfb18.js"/>
<script src="/_next/static/chunks/22158ed5-73e6b9401786cdba.js" async=""></script>
<script src="/_next/static/chunks/8655-649c18685a418c01.js" async=""></script>
<script src="/_next/static/chunks/app/offline/page-67244ec337d81e16.js" async=""></script>
<link rel="preload" href="https://www.googletagmanager.com/gtag/js?id=G-4KB2ZS573N" as="script"/>
<title>Offline</title></head><body>
<script src="/_next/static/chunks/polyfills-42372ed130431b0a.js" noModule=""></script>
<script src="/_next/static/chunks/webpack-b7c79fce3aebfb18.js" id="_R_" async=""></script>
<script>self.__next_f.push([1,"a:HL[\\"/_next/static/media/1755441e3a2fa970-s.p.woff2\\",\\"font\\"]"])</script>
<script type="application/ld+json">{"@context":"https://schema.org"}</script>
</body></html>`;

describe("shellAssetUrls: what the /offline page needs to start", () => {
  it("lists the page's own stylesheets and scripts, in document order, without repeats", () => {
    expect(shellAssetUrls(OFFLINE_HTML, PAGE)).toEqual([
      "/_next/static/css/117c5568da8487e0.css",
      "/_next/static/css/e075b83ea2a5a058.css",
      // The preload and the later <script> name the same file: once.
      "/_next/static/chunks/webpack-b7c79fce3aebfb18.js",
      "/_next/static/chunks/22158ed5-73e6b9401786cdba.js",
      "/_next/static/chunks/8655-649c18685a418c01.js",
      "/_next/static/chunks/app/offline/page-67244ec337d81e16.js",
    ]);
  });

  it("finds the two files the browser check saw fail offline (nothing is hard-coded)", () => {
    const urls = shellAssetUrls(OFFLINE_HTML, PAGE);
    expect(urls).toContain("/_next/static/chunks/8655-649c18685a418c01.js");
    expect(urls).toContain(
      "/_next/static/chunks/app/offline/page-67244ec337d81e16.js",
    );
    // A different build's page gives that build's names.
    const next = OFFLINE_HTML.replaceAll("649c18685a418c01", "0000000000000000");
    expect(shellAssetUrls(next, PAGE)).toContain(
      "/_next/static/chunks/8655-0000000000000000.js",
    );
  });

  it("takes only same-origin /_next/static/ files", () => {
    const html = `
      <script src="https://www.googletagmanager.com/gtag/js?id=G-1" async></script>
      <script src="https://evil.example/_next/static/chunks/x.js"></script>
      <script src="//evil.example/_next/static/chunks/y.js"></script>
      <script src="/_next/static/../../api/keys"></script>
      <script src="/_next/image?url=a"></script>
      <script src="/sw.js"></script>
      <script src="/_next/static/chunks/ok.js"></script>
      <script src="https://weather.mukoko.com/_next/static/chunks/abs.js"></script>
      <script src="relative/chunks/z.js"></script>`;
    expect(shellAssetUrls(html, PAGE)).toEqual([
      "/_next/static/chunks/ok.js",
      "/_next/static/chunks/abs.js",
    ]);
  });

  it("keeps the query string (a deployment id) and decodes entities in it", () => {
    const html = `<script src="/_next/static/chunks/a.js?dpl=dpl_1&amp;v=2"></script>`;
    expect(shellAssetUrls(html, PAGE)).toEqual([
      "/_next/static/chunks/a.js?dpl=dpl_1&v=2",
    ]);
  });

  it("resolves relative references against the page's URL", () => {
    expect(
      shellAssetUrls(
        `<script src="_next/static/chunks/a.js"></script>`,
        "https://weather.mukoko.com/",
      ),
    ).toEqual(["/_next/static/chunks/a.js"]);
  });

  it("skips what a browser with a service worker does not run or does not need", () => {
    const html = `
      <script src="/_next/static/chunks/polyfills-1.js" noModule=""></script>
      <script src="/_next/static/chunks/data.js" type="application/json"></script>
      <link rel="preload" as="font" href="/_next/static/media/a.woff2" crossorigin/>
      <link rel="icon" href="/_next/static/media/icon.png"/>
      <link rel="prefetch" href="/_next/static/chunks/later.js"/>
      <script src="/_next/static/chunks/m.js" type="module"></script>
      <link rel="modulepreload" href="/_next/static/chunks/mp.js"/>
      <link rel="preload" as="style" href="/_next/static/css/p.css"/>`;
    expect(shellAssetUrls(html, PAGE)).toEqual([
      "/_next/static/chunks/m.js",
      "/_next/static/chunks/mp.js",
      "/_next/static/css/p.css",
    ]);
  });

  it("never reads markup out of an inline script's body or a quoted attribute", () => {
    const html = `
      <script>document.write('<script src="/_next/static/chunks/inline.js"><\\/script>')</script>
      <script type="application/ld+json">{"x":"<link rel=stylesheet href=/_next/static/css/no.css>"}</script>
      <!-- <script src="/_next/static/chunks/commented.js"></script> -->
      <meta name="x" content='<script src="/_next/static/chunks/meta.js">'/>
      <link rel="stylesheet" data-note="a > b" href="/_next/static/css/yes.css"/>
      <script src="/_next/static/chunks/real.js"></script>`;
    expect(shellAssetUrls(html, PAGE)).toEqual([
      "/_next/static/css/yes.css",
      "/_next/static/chunks/real.js",
    ]);
  });

  it("reads uppercase tags, single quotes and bare values", () => {
    const html = `<SCRIPT SRC='/_next/static/chunks/a.js' ASYNC></SCRIPT>
      <LINK REL=stylesheet HREF=/_next/static/css/b.css>`;
    expect(shellAssetUrls(html, PAGE)).toEqual([
      "/_next/static/chunks/a.js",
      "/_next/static/css/b.css",
    ]);
  });

  it("is bounded: at most `max` files, MAX_SHELL_ASSETS by default", () => {
    const html = Array.from(
      { length: MAX_SHELL_ASSETS + 25 },
      (_, i) => `<script src="/_next/static/chunks/c${i}.js"></script>`,
    ).join("");
    expect(shellAssetUrls(html, PAGE)).toHaveLength(MAX_SHELL_ASSETS);
    expect(shellAssetUrls(html, PAGE, 3)).toEqual([
      "/_next/static/chunks/c0.js",
      "/_next/static/chunks/c1.js",
      "/_next/static/chunks/c2.js",
    ]);
    expect(MAX_SHELL_ASSETS).toBeLessThanOrEqual(100);
  });

  it("returns nothing for no HTML, no tags or an unusable page URL", () => {
    expect(shellAssetUrls("", PAGE)).toEqual([]);
    expect(shellAssetUrls("<p>hello</p>", PAGE)).toEqual([]);
    expect(shellAssetUrls(OFFLINE_HTML, "not a url")).toEqual([]);
    expect(shellAssetUrls("<script src=", PAGE)).toEqual([]);
  });

  it("does not hang on a long unterminated tag (no catastrophic backtracking)", () => {
    const hostile = `<script ${'a="'.repeat(20_000)}`;
    const started = Date.now();
    expect(shellAssetUrls(hostile, PAGE)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/** A fake cache + network for the glue-free part. */
function fakeShell(html: string | null, options: { have?: string[] } = {}) {
  const stored = new Set<string>(options.have ?? []);
  const fetched: string[] = [];
  const failing = new Set<string>();
  return {
    stored,
    fetched,
    failing,
    deps: {
      pageUrl: PAGE,
      page: async () =>
        html === null ? undefined : new Response(html, { status: 200 }),
      load: async (url: string) => {
        if (stored.has(url)) return true;
        fetched.push(url);
        if (failing.has(url)) return false;
        stored.add(url);
        return true;
      },
    },
  };
}

describe("warmShellAssets", () => {
  it("stores every file the page lists, fetching only what is missing", async () => {
    const shell = fakeShell(OFFLINE_HTML, {
      have: [
        "/_next/static/css/117c5568da8487e0.css",
        "/_next/static/chunks/22158ed5-73e6b9401786cdba.js",
      ],
    });
    const result = await warmShellAssets(shell.deps);
    expect(result).toEqual({ wanted: 6, loaded: 6, failed: 0, complete: true });
    expect(shell.fetched).toHaveLength(4);
    expect(shell.fetched).toContain(
      "/_next/static/chunks/app/offline/page-67244ec337d81e16.js",
    );
    expect(shell.stored.size).toBe(6);
  });

  it("a second pass over a complete shell fetches nothing", async () => {
    const shell = fakeShell(OFFLINE_HTML);
    await warmShellAssets(shell.deps);
    shell.fetched.length = 0;
    const again = await warmShellAssets(shell.deps);
    expect(again.complete).toBe(true);
    expect(shell.fetched).toEqual([]);
  });

  it("reports what failed, stores the rest and is not complete", async () => {
    const shell = fakeShell(OFFLINE_HTML);
    shell.failing.add("/_next/static/chunks/8655-649c18685a418c01.js");
    const result = await warmShellAssets(shell.deps);
    expect(result).toEqual({ wanted: 6, loaded: 5, failed: 1, complete: false });
    expect(shell.stored.has("/_next/static/chunks/8655-649c18685a418c01.js")).toBe(
      false,
    );
  });

  it("never throws: a load that rejects is a failure of that file only", async () => {
    const shell = fakeShell(OFFLINE_HTML);
    const result = await warmShellAssets({
      ...shell.deps,
      load: async (url) => {
        if (url.includes("8655")) throw new Error("offline");
        return true;
      },
    });
    expect(result.failed).toBe(1);
    expect(result.loaded).toBe(5);
    expect(result.complete).toBe(false);
  });

  it("is not complete when the page cannot be read, is not OK, or lists nothing", async () => {
    const none = { wanted: 0, loaded: 0, failed: 0, complete: false };
    expect(await warmShellAssets(fakeShell(null).deps)).toEqual(none);
    expect(
      await warmShellAssets({
        ...fakeShell(OFFLINE_HTML).deps,
        page: async () => new Response("nope", { status: 503 }),
      }),
    ).toEqual(none);
    expect(
      await warmShellAssets({
        ...fakeShell(OFFLINE_HTML).deps,
        page: async () => {
          throw new Error("network");
        },
      }),
    ).toEqual(none);
    expect(await warmShellAssets(fakeShell("<p>no scripts</p>").deps)).toEqual(
      none,
    );
  });

  it("refuses to read an unreasonably large page", async () => {
    const huge = "x".repeat(MAX_SHELL_HTML_CHARS + 1) + OFFLINE_HTML;
    const shell = fakeShell(huge);
    expect((await warmShellAssets(shell.deps)).complete).toBe(false);
    expect(shell.fetched).toEqual([]);
  });

  it("fetches at most `concurrency` files at a time", async () => {
    const html = Array.from(
      { length: 20 },
      (_, i) => `<script src="/_next/static/chunks/c${i}.js"></script>`,
    ).join("");
    let inFlight = 0;
    let peak = 0;
    const result = await warmShellAssets({
      pageUrl: PAGE,
      page: async () => new Response(html),
      concurrency: 4,
      load: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return true;
      },
    });
    expect(result.loaded).toBe(20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("createShellKeeper: a pass that did not finish is repeated, politely", () => {
  const result = (complete: boolean): ShellWarmResult => ({
    wanted: 2,
    loaded: complete ? 2 : 1,
    failed: complete ? 0 : 1,
    complete,
  });

  function keeper(passes: boolean[]) {
    const clock = { now: 1_000_000 };
    const warm = vi.fn(async () => result(passes.shift() ?? true));
    const k = createShellKeeper<string>({ warm, now: () => clock.now });
    return { clock, warm, k };
  }

  it("the first navigation of a worker's life runs a pass (nothing is known yet)", async () => {
    const { k, warm } = keeper([true]);
    expect(k.isComplete()).toBe(false);
    const work = k.retry("nav");
    expect(work).not.toBeNull();
    await work;
    expect(warm).toHaveBeenCalledWith("nav");
    expect(k.isComplete()).toBe(true);
  });

  it("a complete shell is never checked again by navigations", async () => {
    const { k, warm, clock } = keeper([true]);
    await k.ensure("install");
    clock.now += 10 * SHELL_RETRY_GAP_MS;
    expect(k.retry("nav")).toBeNull();
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("an incomplete pass is retried on a later navigation, once the gap has passed", async () => {
    const { k, warm, clock } = keeper([false, true]);
    await k.ensure("install");
    expect(k.isComplete()).toBe(false);

    clock.now += SHELL_RETRY_GAP_MS - 1;
    expect(k.retry("nav")).toBeNull(); // too soon: no storm of retries

    clock.now += 1;
    const work = k.retry("nav");
    expect(work).not.toBeNull();
    await work;
    expect(warm).toHaveBeenCalledTimes(2);
    expect(k.isComplete()).toBe(true);
  });

  it("never runs two passes at once: a navigation during the install pass adds nothing", async () => {
    let release!: () => void;
    const warm = vi.fn(
      () =>
        new Promise<ShellWarmResult>((resolve) => {
          release = () => resolve(result(true));
        }),
    );
    const k = createShellKeeper<string>({ warm, now: () => 0 });
    const first = k.ensure("install");
    await new Promise((r) => setTimeout(r, 0)); // the pass has started
    expect(k.retry("nav")).toBeNull();
    expect(k.ensure("again")).toBe(first); // joins the one running
    release();
    await first;
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("a pass that throws counts as incomplete and is retried later, never rejecting", async () => {
    const clock = { now: 0 };
    let calls = 0;
    const k = createShellKeeper<string>({
      now: () => clock.now,
      warm: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return result(true);
      },
    });
    await expect(k.ensure("install")).resolves.toMatchObject({
      complete: false,
    });
    clock.now += SHELL_RETRY_GAP_MS;
    await k.retry("nav");
    expect(k.isComplete()).toBe(true);
  });
});

describe("boundedBy: an install never waits long on a stalled connection", () => {
  it("resolves when the work does", async () => {
    await expect(boundedBy(Promise.resolve(1), 5_000)).resolves.toBeUndefined();
  });

  it("resolves after the limit when the work never finishes", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      void boundedBy(new Promise(() => {}), 15_000).then(done);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves (does not reject) when the work rejects", async () => {
    await expect(
      boundedBy(Promise.reject(new Error("x")), 5_000),
    ).resolves.toBeUndefined();
  });
});

describe("isStorableStaticAsset: a page is never kept as a script", () => {
  const reply = (status: number, type?: string) =>
    new Response("x", {
      status,
      headers: type ? { "content-type": type } : {},
    });

  it("keeps scripts, styles, fonts and maps answered with 200", () => {
    for (const type of [
      "application/javascript; charset=UTF-8",
      "text/javascript",
      "text/css; charset=UTF-8",
      "font/woff2",
      "application/json",
      undefined,
    ]) {
      expect(isStorableStaticAsset(reply(200, type)), String(type)).toBe(true);
    }
  });

  it("refuses HTML under a static URL (a captive portal, an error page, a preload response)", () => {
    expect(isStorableStaticAsset(reply(200, "text/html; charset=utf-8"))).toBe(
      false,
    );
    expect(isStorableStaticAsset(reply(200, "TEXT/HTML"))).toBe(false);
  });

  it("refuses anything but a plain 200", () => {
    for (const status of [201, 204, 206, 301, 304, 404, 500]) {
      expect(isStorableStaticAsset({ status, headers: new Headers() })).toBe(
        false,
      );
    }
  });
});

