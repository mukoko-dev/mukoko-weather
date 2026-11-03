/**
 * The pinned validator is what every wire-format test is judged by, so what it
 * is, where it came from and when it was read are tested too: a hand edit of the
 * fixture, a header that no longer says what the file is, or a pin that drifted
 * from the sidecar fails here instead of quietly changing the judge.
 *
 * Nothing here talks to a server. Whether the LIVE CouchDB has this function
 * installed is not something these tests can know.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYNCED_FORECAST_MODELS } from "./couch-docs";
import {
  loadValidator,
  pinnedFixtureSource,
  pinnedFixtureText,
  pinnedGatewayFile,
  validateDoc,
  validatorForecastModels,
  validatorPreferenceKeys,
  validatorSchemas,
  validatorThemeValues,
} from "./test-support/couch-validator-facts";

const REPO = join(__dirname, "..", "..", "..");
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
/** A git blob id: SHA-1 over "blob <bytes>\0" and the bytes. */
const gitBlobSha = (text: string) => {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
};

describe("the pinned copy of nyuchi-api's couch_validate_personal.js", () => {
  const source = pinnedFixtureSource();
  const header = pinnedFixtureText().slice(
    0,
    pinnedFixtureText().indexOf(source.marker),
  );

  it("under the marker line is the gateway's file byte for byte: the hashes in the sidecar, which nyuchi-api pins for its own copy, match it", () => {
    const body = pinnedGatewayFile();
    expect(sha256(body)).toBe(source.sha256);
    expect(gitBlobSha(body)).toBe(source.blobSha);
    // The sha-256 nyuchi-api's couch_validate_personal.source.json states.
    expect(source.nyuchiApiPin.sha256).toBe(source.sha256);
    expect(source.nyuchiApiPin.file).toBe(
      "gateway/lib/couch_validate_personal.source.json",
    );
  });

  it("the sidecar names the source file, the commit, the date it was last changed and the day it was read", () => {
    expect(source.repo).toBe("nyuchi/nyuchi-api");
    expect(source.path).toBe("gateway/lib/couch_validate_personal.js");
    expect(source.lastChangeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.nyuchiApiPin.dataInfraCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.stagingHeadWhenRead).toMatch(/^[0-9a-f]{40}$/);
    expect(source.lastChangeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(source.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(source.readOn >= source.lastChangeDate).toBe(true);
  });

  it("the header of the fixture says the same, and how to re-pin it", () => {
    for (const fact of [
      source.repo,
      source.path,
      source.lastChangeCommit,
      source.stagingHeadWhenRead,
      source.readOn,
      source.blobSha,
      source.sha256,
      source.nyuchiApiPin.dataInfraCommit,
      "RE-PIN",
      "curl -H 'Accept: application/vnd.github.raw'",
      "contents/gateway/lib/couch_validate_personal.js?ref=staging",
    ]) {
      expect(header, fact).toContain(fact);
    }
    // It does not claim a live server was checked.
    expect(header).toMatch(
      /Nothing here has run against a live\s+\/\/ CouchDB/,
    );
  });

  it("is the generated validator for the data model's seven types, not the earlier hand-written one", () => {
    const body = pinnedGatewayFile();
    expect(body).toContain("Generated from schemas/model/userdb.yaml");
    expect(Object.keys(validatorSchemas()).sort()).toEqual(
      [
        "activity",
        "deviceNote",
        "engagementEvent",
        "historyEntry",
        "interest",
        "preference",
        "savedPlace",
      ].sort(),
    );
    // None of the earlier contract's traits.
    expect(body).not.toContain("ownerPersonId");
  });

  it("is a function that loads and runs", () => {
    const validator = loadValidator(() => Date.parse("2026-11-03T00:00:00Z"));
    expect(typeof validator).toBe("function");
    expect(
      validateDoc(
        {
          _id: "activity:livestock",
          type: "activity",
          schemaVersion: "v3.1",
          deviceId: "11111111-2222-4333-8444-555555555555",
          createdAt: "2026-11-02T10:00:00.000Z",
          updatedAt: "2026-11-02T10:00:00.000Z",
          activityId: "livestock",
        },
        { serverNowMs: () => Date.parse("2026-11-03T00:00:00Z") },
      ),
    ).toEqual({ ok: true });
  });

  it("the lists the client keeps are derived from it: every synced forecast model is in the validator's enum", () => {
    for (const model of SYNCED_FORECAST_MODELS) {
      expect(validatorForecastModels(), model).toContain(model);
    }
    expect(validatorThemeValues()).toEqual(["light", "dark", "system"]);
    expect(validatorPreferenceKeys()).toEqual(
      expect.arrayContaining(["theme", "forecastModel"]),
    );
  });

  it("the fixture's header says the same thing as the docs, so a re-pin updates both", () => {
    // Line breaks in the markdown are not part of what it says.
    const docs = readFileSync(
      join(REPO, "docs", "couchdb-sync.md"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(docs).toContain(source.lastChangeCommit.slice(0, 9));
    expect(docs).toContain(source.lastChangeCommit);
    expect(docs).toContain(source.blobSha);
    expect(docs).toContain(source.sha256);
    expect(docs).toContain(source.readOn);
    expect(docs).toContain(
      "re-pin this fixture whenever nyuchi-api's couch_validate_personal.js changes",
    );
    expect(docs).toContain(
      "curl -H 'Accept: application/vnd.github.raw' 'https://api.github.com/repos/nyuchi/nyuchi-api/contents/gateway/lib/couch_validate_personal.js?ref=staging'",
    );
  });
});
