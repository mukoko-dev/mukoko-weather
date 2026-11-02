/**
 * With `FLAGS.couch_sync` off (the default) nothing changes for a visitor:
 * no request to `/api/couch/*` or the API host, no sync code in the first-load
 * JavaScript, no IndexedDB database. These tests are the guard, in two parts:
 * behaviour (start with the flag off, with it on) and source (who may import
 * what), so a later change that wires the sync in eagerly fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { FLAGS } from "../feature-flags";
import { _resetCouchSyncStart, startCouchSync } from "./couch-sync-start";
import { FakeBridge } from "./test-support/couch-engine-harness";

const SRC = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// A browser, as far as startCouchSync looks at one
// ---------------------------------------------------------------------------

function stubBrowser(flag: "true" | "false" | null) {
  const storage = new Map<string, string>();
  if (flag) storage.set("ff:couch_sync", flag);
  const listeners: string[] = [];
  const win = {
    addEventListener: (type: string) => listeners.push(`window:${type}`),
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (type: string) => listeners.push(`document:${type}`),
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("navigator", { onLine: true });
  return { listeners };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetCouchSyncStart();
  fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("behaviour", () => {
  it("the flag is off in code", () => {
    expect(FLAGS.couch_sync).toBe(false);
  });

  it("flag off: nothing is requested, no listener is added, no handle is returned", async () => {
    const { listeners } = stubBrowser(null);
    const bridge = new FakeBridge({ theme: "dark" });
    const handle = await startCouchSync(bridge, "device");
    expect(handle).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listeners).toEqual([]);
    expect(bridge.listenerCount).toBe(0);
  });

  it("flag explicitly false: the same", async () => {
    stubBrowser("false");
    expect(await startCouchSync(new FakeBridge(), "device")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no browser (the server render): nothing happens", async () => {
    vi.stubGlobal("window", undefined);
    expect(await startCouchSync(new FakeBridge(), "device")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag on: the only request is to our own session route, never the API host", async () => {
    stubBrowser("true");
    const bridge = new FakeBridge();
    const handle = await startCouchSync(bridge, "device");
    expect(handle).not.toBeNull();
    // Let the first cycle ask for a credential (a 401: signed out).
    for (let i = 0; i < 20 && fetchSpy.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["/api/couch/session"]);
    await handle?.stop();
    expect(bridge.listenerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Source: who may import the sync code
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const files = walk(SRC).filter((f) => !/\.test\.(ts|tsx)$/.test(f));
const rel = (f: string) => relative(SRC, f).split("\\").join("/");
const text = (f: string) => readFileSync(f, "utf8");
/** Source without block comments and whole-line comments: the guards read code, not prose. */
const code = (f: string) =>
  text(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Modules that must never reach a page's first-load JavaScript. */
const HEAVY = [
  "couch-sync-start",
  "couch-sync",
  "couch-rxdb",
  "couch-session",
  "couch-fetch",
  "couch-schedule",
];

function staticImportersOf(name: string): string[] {
  // `import ... from "./couch-x"` and `export ... from`, not `import type`,
  // not a dynamic `import("...")`.
  const re = new RegExp(
    `^\\s*(?:import|export)\\s+(?!type\\b)[^;]*?from\\s+["'][^"']*/${name}["']`,
    "m",
  );
  return files.filter((f) => !rel(f).startsWith("lib/rxdb/couch-") && re.test(text(f))).map(rel);
}

describe("source", () => {
  it("no file outside the sync modules statically imports them", () => {
    for (const name of HEAVY) {
      expect(staticImportersOf(name), name).toEqual([]);
    }
  });

  it("store.ts reaches the sync only through a dynamic import behind the flag", () => {
    const store = text(join(SRC, "lib", "store.ts"));
    // No value import of any couch module; types are erased.
    for (const line of store.split("\n")) {
      if (/^\s*import\b/.test(line) && /couch-/.test(line)) {
        expect(line, line).toMatch(/^\s*import type\b/);
      }
    }
    const dynamic = store.match(/import\("\.\/rxdb\/couch-[a-z-]+"\)/g) ?? [];
    expect(dynamic).toEqual(['import("./rxdb/couch-sync-start")']);

    // The flag is read before the import, in the same function.
    const fn = store.slice(store.indexOf("function startCouchSyncIfEnabled"));
    const flagAt = fn.indexOf('getFeatureFlag("couch_sync")');
    const importAt = fn.indexOf('import("./rxdb/couch-sync-start")');
    expect(flagAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(flagAt);
    expect(fn.slice(flagAt, importAt)).toMatch(/return;/);
  });

  it("couch-sync-start reads the flag before importing anything", () => {
    const start = text(join(SRC, "lib", "rxdb", "couch-sync-start.ts"));
    const flagAt = start.indexOf('getFeatureFlag("couch_sync")');
    const firstImport = start.indexOf('import("./couch-');
    expect(flagAt).toBeGreaterThan(-1);
    expect(firstImport).toBeGreaterThan(flagAt);
  });

  it("RxDB's CouchDB plugin is imported only by the dynamically loaded RxDB layer", () => {
    const importers = files
      .filter((f) => /replication-couchdb/.test(text(f)))
      .map(rel);
    expect(importers).toEqual(["lib/rxdb/couch-rxdb.ts"]);
  });

  it("the existing /v1/devices replication is untouched by the sync", () => {
    const replication = text(join(SRC, "lib", "rxdb", "replication.ts"));
    expect(replication).not.toMatch(/couch/i);
    const profile = text(join(SRC, "lib", "rxdb", "device-profile.ts"));
    expect(profile).not.toMatch(/couch/i);
  });

  it("no sync module holds an API host: the origin comes from the session route", () => {
    for (const f of files.filter((f) => rel(f).startsWith("lib/rxdb/couch-"))) {
      expect(code(f), rel(f)).not.toMatch(/api\.nyuchi\.com/);
      expect(code(f), rel(f)).not.toMatch(/process\.env/);
    }
  });

  it("no sync module logs", () => {
    for (const f of files.filter((f) => rel(f).startsWith("lib/rxdb/couch-"))) {
      expect(code(f), rel(f)).not.toMatch(
        /\bconsole\.(log|info|warn|error|debug)\b/,
      );
    }
  });

  it("the sync stores nothing in web storage (the credential lives in memory)", () => {
    for (const f of files.filter((f) => rel(f).startsWith("lib/rxdb/couch-"))) {
      expect(code(f), rel(f)).not.toMatch(
        /localStorage|sessionStorage|writeStorage|document\.cookie/,
      );
    }
  });
});
