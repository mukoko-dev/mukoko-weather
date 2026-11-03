/**
 * The timing module is the one place the credential route's address and the
 * floors around it are defined. If the address were written twice and one copy
 * changed, the proxy would stop refreshing the WorkOS token on the route and
 * the short-grant loop (a burst of exchanges) would come back with no compile
 * error and no failing test. So: one definition, the real route sits there,
 * and nothing else spells it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS,
  COUCH_MIN_ACCESS_TOKEN_LIFE_MS,
  COUCH_MIN_GRANT_LIFE_MS,
  COUCH_SESSION_PATH,
  REFRESH_MIN_DELAY_MS,
} from "./couch-session-timing";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the credential route's address", () => {
  it("is the folder the route handler lives in", () => {
    const routeFile = join(SRC, "app", "api", "couch", "session", "route.ts");
    expect(statSync(routeFile).isFile()).toBe(true);
    const served =
      "/" +
      relative(join(SRC, "app"), join(routeFile, "..")).split(sep).join("/");
    expect(COUCH_SESSION_PATH).toBe(served);
  });

  it("is spelled in one place; the page's client, the proxy and the tests use the constant", () => {
    const spelling = sources(SRC).filter((f) =>
      /["'`]\/api\/couch\/session["'`]/.test(code(f)),
    );
    expect(spelling.map((f) => relative(SRC, f))).toEqual([
      "lib/couch-session-timing.ts",
    ]);
  });

  it("the page's client asks on the same constant, not a copy of it", () => {
    const client = code(join(SRC, "lib", "rxdb", "couch-session.ts"));
    expect(client).toMatch(
      /import\s*\{[^}]*\bCOUCH_SESSION_PATH\b[^}]*\}\s*from\s*["']\.\.\/couch-session-timing["']/,
    );
    expect(client).not.toMatch(/SESSION_ROUTE/);
  });

  it("the proxy refreshes the token on that constant", () => {
    const proxy = code(join(SRC, "proxy.ts"));
    expect(proxy).toMatch(/COUCH_SESSION_PATH/);
    expect(proxy).toMatch(/COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS/);
  });
});

describe("the floors agree", () => {
  it("proxy buffer > issuer floor > page floor > the page's renewal lead (60 s) > 0", () => {
    expect(COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS * 1000).toBeGreaterThan(
      COUCH_MIN_ACCESS_TOKEN_LIFE_MS,
    );
    expect(COUCH_MIN_ACCESS_TOKEN_LIFE_MS).toBeGreaterThan(
      COUCH_MIN_GRANT_LIFE_MS,
    );
    expect(COUCH_MIN_GRANT_LIFE_MS).toBeGreaterThan(60_000);
    expect(REFRESH_MIN_DELAY_MS).toBeGreaterThan(0);
  });
});
