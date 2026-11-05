/**
 * Where a person's activities and saved places are KEPT is one file
 * (`person-preferences-store.ts`). This test fails if the route, the browser
 * merge or their tests start naming a database, a collection or a field of the
 * store, or if the store reaches storage any way but the shared `mongo.ts`
 * accessor. That is what lets the home move (the person's CouchDB database,
 * another record) by changing one file.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** Every module specifier a source file imports, statically or dynamically. */
function importsOf(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

/** Strip comments so prose in a header cannot trip (or hide) a check. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const ROUTE = "app/api/profile/preferences/route.ts";
const STORE = "lib/person-preferences-store.ts";
const CLIENT_SIDE = [
  "lib/person-preferences.ts",
  "lib/person-preferences-switches.ts",
  "lib/person-preferences-sync.ts",
  "lib/person-preferences-sync-start.ts",
  "lib/person-preferences-state.ts",
  "lib/use-person-preferences-sync.ts",
  "components/profile/PersonPreferencesSync.tsx",
];
const STORE_VOCABULARY =
  /identityDb|personsCollection|\.collection\(|workosUserId|\bMongo|mongodb|\$push|\$pull|\$elemMatch|bulkWrite|updateOne|findOne/;

describe("the route", () => {
  const source = read(ROUTE);

  it("imports storage only through the one store module", () => {
    expect(importsOf(source).sort()).toEqual(
      [
        "@/lib/api-route-guards",
        "@/lib/observability",
        "@/lib/person-preferences",
        "@/lib/person-preferences-store",
        "@/lib/person-preferences-switches",
        "@/lib/user-rate-limit",
        "next/server",
      ].sort(),
    );
  });

  it("names no database, collection or field of the store", () => {
    expect(code(source)).not.toMatch(STORE_VOCABULARY);
  });
});

describe("the store module", () => {
  const source = read(STORE);

  it("reaches storage only through the shared mongo.ts accessor", () => {
    expect(importsOf(source).sort()).toEqual(
      ["./mongo", "./person-preferences"].sort(),
    );
    const fromMongo = source.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/mongo"/);
    expect(fromMongo?.[1].trim()).toBe("identityDb");
  });

  it("adds no client, no URL and no secret", () => {
    const body = code(source);
    expect(body).not.toMatch(/new MongoClient|MONGODB_URI|process\.env/);
    expect(body).not.toMatch(/\bfetch\s*\(|https?:\/\//);
  });

  it("creates nothing and replaces nothing: no collection, index, upsert or delete", () => {
    expect(code(source)).not.toMatch(
      /createCollection|createIndex|ensureIndex|dropIndex|\.drop\(|upsert|insertOne|insertMany|replaceOne|deleteOne|deleteMany|\$setOnInsert/,
    );
  });

  it("opens only the person's own record collection, with an allowlist of two fields", () => {
    const body = code(source);
    expect(body.match(/\.collection\("([^"]+)"\)/g)).toEqual([
      '.collection("persons")',
    ]);
    // The one write sets the two lists and the record's updatedAt, nothing else.
    const set = new Set(
      [...body.matchAll(/\bset\.(\w+)\s*=/g)].map((m) => m[1]),
    );
    expect(set).toEqual(new Set(["activities", "savedPlaces", "updatedAt"]));
    expect(body.match(/\bcol\.updateOne\(/g)).toHaveLength(1);
    expect(body).not.toMatch(/\$push|\$pull|\$unset|\$inc|bulkWrite/);
  });

  it("says it is the interim home and where the truth moves", () => {
    expect(source).toMatch(/INTERIM HOME/);
    expect(source).toMatch(/CouchDB/);
    expect(source).toMatch(/ONE FILE TO CHANGE/);
  });
});

describe("everything else", () => {
  it.each(CLIENT_SIDE)("%s does not touch storage", (file) => {
    const source = read(file);
    for (const spec of importsOf(source)) {
      expect(spec).not.toMatch(
        /(^|\/)(mongo|db|person-preferences-store)$|^mongodb$/,
      );
    }
    expect(code(source)).not.toMatch(STORE_VOCABULARY);
  });

  it("the legacy device-profile replication reads only the two-value state module", () => {
    const specs = importsOf(read("lib/rxdb/replication.ts")).filter((s) =>
      /person-preferences/.test(s),
    );
    expect(specs).toEqual(["../person-preferences-state"]);
  });

  it("only the route imports the store module", () => {
    const importers = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) =>
        importsOf(readFileSync(f, "utf8")).some((s) =>
          /person-preferences-store$/.test(s),
        ),
      )
      .map((f) => relative(SRC, f));
    expect(importers.sort()).toEqual([ROUTE]);
  });

  it("the tests of the route and the merge do not name the store's database, collection or fields either", () => {
    for (const file of [
      "app/api/profile/preferences/preferences-route.test.ts",
      "app/api/profile/preferences/preferences-route-off.test.ts",
      "lib/person-preferences-sync.test.ts",
      "lib/person-preferences-sync-start.test.ts",
      "lib/use-person-preferences-sync.test.ts",
    ]) {
      expect(code(read(file)), file).not.toMatch(
        /identityDb|personsCollection|\.collection\(|workosUserId|mongodb|\$push|\$pull|\$elemMatch|bulkWrite/,
      );
    }
  });

  it("the shared accessor the store uses exists", () => {
    expect(read("lib/mongo.ts")).toMatch(/export function identityDb\(\)/);
  });
});
