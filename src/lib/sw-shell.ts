/**
 * Keeping the `/offline` page able to START while offline (issue #414).
 *
 * The service worker precaches the `/offline` HTML, but a page is not its
 * HTML: React cannot hydrate until the page's scripts have loaded. The worker
 * used to cache `/_next/static/` files only the first time a page used them,
 * so the scripts of a route the visitor had never opened online (this page)
 * were missing offline, hydration failed and the root error boundary
 * ("Something went wrong") showed instead of "You're offline".
 *
 * The fix reads the list from the page itself, never from a hard-coded hash:
 * the worker takes the `/offline` HTML it just precached, pulls out its
 * same-origin `/_next/static/` scripts and stylesheets (`shellAssetUrls`) and
 * makes sure each one is stored (`warmShellAssets`). Everything here is pure
 * or takes its I/O as arguments, so it is tested without a browser; the glue
 * (the cache, `fetch`, the events) is `src/app/sw.ts`.
 *
 * Rules:
 * - Best effort. Nothing here ever throws, and a failure never fails the
 *   worker's install: the visitor would only lose what they lose today.
 * - Only same-origin files under `/_next/static/` are taken, at most
 *   `MAX_SHELL_ASSETS` of them, from at most `MAX_SHELL_HTML_CHARS` of HTML.
 *   Nothing else a page mentions (analytics, fonts from elsewhere, inline
 *   scripts) is touched.
 * - A file that is already stored is not fetched again.
 * - A pass that did not store everything is repeated on a later navigation
 *   (`createShellKeeper`), at most once a minute, never while one is running.
 */

/** The cache the `/_next/static/` CacheFirst route reads (and this fills). */
export const STATIC_ASSETS_CACHE = "static-assets";

/** Only files under this path are ever taken from the page. */
export const SHELL_ASSET_PREFIX = "/_next/static/";

/**
 * Most files taken from one page. The `/offline` page lists about 35; a page
 * that lists far more than this is not a small shell and is cut short.
 */
export const MAX_SHELL_ASSETS = 100;

/** Longest HTML read for its list (the `/offline` page is about 60 KB). */
export const MAX_SHELL_HTML_CHARS = 1_000_000;

/** Files fetched at the same time. */
export const SHELL_FETCH_CONCURRENCY = 6;

/** A failed or partial pass is tried again no sooner than this. */
export const SHELL_RETRY_GAP_MS = 60_000;

/** Longest the worker's install waits for the pass. */
export const SHELL_INSTALL_TIMEOUT_MS = 15_000;

/**
 * A response worth keeping under a `/_next/static/` URL. Those files are
 * scripts, stylesheets, fonts and maps, never a page: an HTML answer to a
 * script's URL (a captive portal, a proxy's error page sent with a 200, the
 * wrong response handed to the wrong request) must not be stored as that
 * script, or the file is poisoned for good and the page cannot start.
 */
export function isStorableStaticAsset(
  response: Pick<Response, "status" | "headers">,
): boolean {
  if (response.status !== 200) return false;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  return !type.startsWith("text/html");
}

// ── Reading the list from the page ──────────────────────────────────────────

/**
 * A comment, or an opening tag of any kind (so the quoted value of a `<meta>`
 * or a `data-` attribute is consumed whole and never read as markup); quoted
 * values may hold `>`.
 */
const TAG_RE =
  /<!--[\s\S]*?-->|<([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
/** The end of a script element, so inline code is never read as markup. */
const SCRIPT_END_RE = /<\/script\b/gi;
/** One attribute: name, then an optional quoted or bare value. */
const ATTR_RE =
  /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Script types a browser runs as JavaScript (none given is JavaScript). */
const SCRIPT_TYPES = new Set([
  "module",
  "text/javascript",
  "application/javascript",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (whole, hex?: string, dec?: string, name?: string) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
      const code = hex ? parseInt(hex, 16) : parseInt(dec ?? "", 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    },
  );
}

/** The attributes of a tag, names lowercased, the first of a name winning. */
function attributesOf(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of source.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (attrs.has(name)) continue;
    attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

/** The reference a script or link tag loads that the shell needs, or null. */
function shellReferenceOf(
  tag: string,
  attrs: Map<string, string>,
): string | null {
  if (tag === "script") {
    // Browsers with a service worker run modules: the polyfill script marked
    // `nomodule` is never fetched by them, so it is not worth storing.
    if (attrs.has("nomodule")) return null;
    const type = attrs.get("type")?.trim().toLowerCase();
    if (type && !SCRIPT_TYPES.has(type)) return null;
    return attrs.get("src") ?? null;
  }
  const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
  const as = (attrs.get("as") ?? "").toLowerCase();
  const wanted =
    rel.includes("stylesheet") ||
    rel.includes("modulepreload") ||
    (rel.includes("preload") && (as === "script" || as === "style"));
  return wanted ? (attrs.get("href") ?? null) : null;
}

/**
 * The same-origin `/_next/static/` scripts and stylesheets a page loads, as
 * `path?query`, in document order, without repeats, at most `max`.
 *
 * `pageUrl` is the absolute URL the HTML was served from (relative references
 * resolve against it, and a reference to another origin is dropped).
 */
export function shellAssetUrls(
  html: string,
  pageUrl: string,
  max: number = MAX_SHELL_ASSETS,
): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  const tags = new RegExp(TAG_RE.source, TAG_RE.flags);
  const ends = new RegExp(SCRIPT_END_RE.source, SCRIPT_END_RE.flags);

  for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
    if (m[1] === undefined) continue; // a comment
    const tag = m[1].toLowerCase();
    if (tag !== "script" && tag !== "link") continue;
    if (tag === "script") {
      // Skip the element's body: inline JSON and code are not markup.
      ends.lastIndex = tags.lastIndex;
      const end = ends.exec(html);
      if (end) tags.lastIndex = end.index;
    }
    const ref = shellReferenceOf(tag, attributesOf(m[2]));
    if (!ref) continue;

    let url: URL;
    try {
      url = new URL(ref.trim(), base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    if (!url.pathname.startsWith(SHELL_ASSET_PREFIX)) continue;
    const key = url.pathname + url.search;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(key);
    if (found.length >= max) break;
  }
  return found;
}

// ── Making them available ───────────────────────────────────────────────────

export interface ShellWarmDeps {
  /** The `/offline` HTML: the precached copy, else the network's. */
  page(): Promise<Response | undefined | null>;
  /** The absolute URL that HTML is served from. */
  pageUrl: string;
  /** The file is already stored (a plain lookup: no fetch, no bookkeeping). */
  has(url: string): Promise<boolean>;
  /** Fetch and store one file. True when it is now available offline. */
  load(url: string): Promise<boolean>;
  concurrency?: number;
}

export interface ShellWarmResult {
  /** Files the page asked for. */
  wanted: number;
  /** Files that are now available offline. */
  loaded: number;
  /** Files that could not be stored this time. */
  failed: number;
  /** Everything the page asked for is available (and it asked for something). */
  complete: boolean;
}

const NOTHING: ShellWarmResult = {
  wanted: 0,
  loaded: 0,
  failed: 0,
  complete: false,
};

/**
 * Make every file the `/offline` page loads available offline. Never throws.
 * A page with no readable HTML, or one that lists no files, is not complete.
 */
export async function warmShellAssets(
  deps: ShellWarmDeps,
): Promise<ShellWarmResult> {
  let html: string;
  try {
    const response = await deps.page();
    if (!response || !response.ok) return NOTHING;
    html = await response.text();
  } catch {
    return NOTHING;
  }
  if (html.length > MAX_SHELL_HTML_CHARS) return NOTHING;

  const urls = shellAssetUrls(html, deps.pageUrl);
  if (urls.length === 0) return NOTHING;

  let loaded = 0;
  let failed = 0;
  const queue = [...urls];
  const lanes = Math.max(
    1,
    Math.min(deps.concurrency ?? SHELL_FETCH_CONCURRENCY, urls.length),
  );
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        // A file already stored costs one lookup: a pass runs on the first
        // navigation of every worker start, and must not touch the network
        // or the expiry bookkeeping for files that are there. A lookup that
        // fails says nothing about the file: it is fetched as if missing.
        let ok = false;
        try {
          ok = await deps.has(url);
        } catch {
          ok = false;
        }
        if (!ok) {
          try {
            ok = await deps.load(url);
          } catch {
            ok = false;
          }
        }
        if (ok) loaded += 1;
        else failed += 1;
      }
    }),
  );
  return { wanted: urls.length, loaded, failed, complete: failed === 0 };
}

// ── Repeating a pass that did not finish ────────────────────────────────────

export interface ShellKeeperOptions<C> {
  /** One pass. `context` is whatever the caller needs to run it (an event). */
  warm(context: C): Promise<ShellWarmResult>;
  now(): number;
  /** Least time between passes started by `retry` (default one minute). */
  retryGapMs?: number;
}

export interface ShellKeeper<C> {
  /** Run a pass now (the worker's install). One at a time: joins one running. */
  ensure(context: C): Promise<ShellWarmResult>;
  /**
   * Run a pass if the last one did not store everything (or none has run in
   * this worker yet), none is running and the gap has passed. Returns the work
   * for `event.waitUntil`, or null when there is nothing to do.
   */
  retry(context: C): Promise<ShellWarmResult> | null;
  /** The last pass stored everything. */
  isComplete(): boolean;
}

export function createShellKeeper<C>(
  options: ShellKeeperOptions<C>,
): ShellKeeper<C> {
  const gap = options.retryGapMs ?? SHELL_RETRY_GAP_MS;
  let complete = false;
  let running: Promise<ShellWarmResult> | null = null;
  let lastStart = -Infinity;

  const run = (context: C): Promise<ShellWarmResult> => {
    if (running) return running;
    lastStart = options.now();
    const pass: Promise<ShellWarmResult> = Promise.resolve()
      .then(() => options.warm(context))
      .catch(() => NOTHING)
      .then((result) => {
        complete = result.complete;
        running = null;
        return result;
      });
    running = pass;
    return pass;
  };

  return {
    ensure: run,
    retry(context) {
      if (complete || running) return null;
      if (options.now() - lastStart < gap) return null;
      return run(context);
    },
    isComplete: () => complete,
  };
}

/**
 * Wait for `work`, but no longer than `ms`; resolves either way and never
 * rejects, so it can be handed to `event.waitUntil` without holding an install
 * hostage to a stalled connection.
 */
export function boundedBy(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}
