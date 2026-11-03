/**
 * What the credential route and the page agree on, in a module that imports
 * nothing: the name of a person's database, and the one code a 401 carries when
 * (and only when) nobody is signed in. The server files (the issuer and the
 * route) import this, not the sync engine's modules, so the activity catalogue
 * and the Open-Meteo client do not travel into the route's bundle.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SIGNED_OUT_CODE,
  personIdFromDatabase,
} from "./couch-session-contract";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const SRC = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("personIdFromDatabase", () => {
  it("reads the person id from a personal database name only", () => {
    expect(personIdFromDatabase(`user_${PERSON}`)).toBe(PERSON);
    for (const bad of [
      "family_x",
      "user_",
      "user_UPPER",
      "user_a/b",
      "_users",
      "",
      null,
      7,
    ]) {
      expect(personIdFromDatabase(bad), String(bad)).toBeNull();
    }
  });
});

describe("the signed-out code", () => {
  it("is a stable word the client matches, not a status", () => {
    expect(SIGNED_OUT_CODE).toBe("signed_out");
  });
});

describe("the server files stay out of the sync engine's modules", () => {
  const importsOf = (text: string) =>
    [...code(text).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

  it("the contract imports nothing", () => {
    expect(importsOf(read("lib", "couch-session-contract.ts"))).toEqual([]);
  });

  it.each([
    ["lib", "couch-session-issuer.ts"],
    ["app", "api", "couch", "session", "route.ts"],
  ])("%s imports nothing from the rxdb layer", (...path) => {
    const imports = importsOf(read(...path));
    expect(imports.filter((i) => /rxdb/.test(i))).toEqual([]);
  });

  it("the page's client and the issuer take the database name from the contract", () => {
    for (const path of [
      ["lib", "couch-session-issuer.ts"],
      ["lib", "rxdb", "couch-session.ts"],
    ]) {
      const imports = importsOf(read(...path));
      expect(
        imports.some((i) => /couch-session-contract$/.test(i)),
        path.join("/"),
      ).toBe(true);
    }
  });
});
