/**
 * One rule for "a bare origin" (an https origin, http only for localhost, no
 * credentials, path, query or fragment), shared by the server's gateway config
 * and the browser's sync client, which must not import each other's modules.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBareOrigin } from "./bare-origin";
import { gatewayOrigin } from "./nyuchi-gateway";
import { parseApiOrigin } from "./rxdb/couch-session";

const ok: [string, string][] = [
  ["https://api.nyuchi.com", "https://api.nyuchi.com"],
  ["https://api.nyuchi.com/", "https://api.nyuchi.com"],
  ["https://API.Nyuchi.com", "https://api.nyuchi.com"],
  ["https://api.nyuchi.com:8443", "https://api.nyuchi.com:8443"],
  ["http://localhost:8000", "http://localhost:8000"],
  ["http://127.0.0.1:8000", "http://127.0.0.1:8000"],
  ["http://[::1]:8000", "http://[::1]:8000"],
];
const refused: unknown[] = [
  undefined,
  null,
  7,
  {},
  "",
  "   ",
  "api.nyuchi.com",
  "http://api.nyuchi.com",
  "http://example.com",
  "ftp://api.nyuchi.com",
  "javascript:alert(1)",
  "https://api.nyuchi.com/v1",
  "https://api.nyuchi.com/?x=1",
  "https://api.nyuchi.com/#x",
  "https://u:p@api.nyuchi.com",
  "https://u@api.nyuchi.com",
];

describe("parseBareOrigin", () => {
  it.each(ok)("%s -> %s", (input, origin) => {
    expect(parseBareOrigin(input)).toBe(origin);
  });
  it.each(refused.map((r) => [r]))("refuses %j", (input) => {
    expect(parseBareOrigin(input)).toBeNull();
  });
  it("an empty or blank string is nothing (the URL parser would only throw)", () => {
    expect(parseBareOrigin("")).toBeNull();
    expect(parseBareOrigin("  ")).toBeNull();
  });
});

describe("the server and the browser decide alike", () => {
  const all: unknown[] = [...ok.map(([i]) => i), ...refused];
  it.each(all.map((i) => [i]))("%j", (input) => {
    const server = gatewayOrigin({
      NYUCHI_API_URL: typeof input === "string" ? input : undefined,
    });
    const browser = parseApiOrigin(input);
    // The server trims the variable first (a trailing newline in a secret
    // store); apart from that they are one rule.
    const expected =
      typeof input === "string" ? parseBareOrigin(input.trim() || null) : null;
    expect(server).toBe(expected);
    expect(browser).toBe(parseBareOrigin(input));
  });
});

describe("one definition", () => {
  const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

  it("both callers use the shared module and neither keeps a copy of the rule", () => {
    for (const rel of ["nyuchi-gateway.ts", "rxdb/couch-session.ts"]) {
      const source = read(rel);
      expect(source, rel).toMatch(/from "(?:\.\.?\/)bare-origin"/);
      expect(source, rel).not.toMatch(/LOCAL_HOSTS/);
      expect(source, rel).not.toMatch(/url\.protocol/);
    }
  });

  it("the shared module is dependency free, so the browser bundle takes nothing server-only with it", () => {
    const source = read("bare-origin.ts");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/process\.|node:|require\(/);
  });
});
