/**
 * `tests/fixtures/report-submit.json` is the oracle for the Rust report builder:
 * what the real Python `submit_report` stored. The Python is deleted, so the
 * fixture names the git commit it was generated from and a script regenerates
 * it from that commit. Pinned here so the claim stays reproducible.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const script = readFileSync(
  resolve(ROOT, "scripts/gen_report_submit_fixtures.py"),
  "utf-8",
);
const fixture = JSON.parse(
  readFileSync(resolve(ROOT, "tests/fixtures/report-submit.json"), "utf-8"),
) as {
  _generated: { by: string; commit: string; source: string };
  ip: string;
  cases: { name: string; expected: { error?: unknown; doc?: unknown } }[];
};

describe("report-submit fixture", () => {
  it("records the pinned commit it was generated from, and the script agrees", () => {
    expect(fixture._generated.commit).toMatch(/^[0-9a-f]{40}$/);
    const pinned = /^PINNED_COMMIT = "([0-9a-f]{40})"$/m.exec(script);
    expect(pinned?.[1]).toBe(fixture._generated.commit);
    expect(fixture._generated.by).toBe("scripts/gen_report_submit_fixtures.py");
  });

  it("takes the Python from git at that commit, never from the working tree", () => {
    expect(script).toContain('"git", "archive"');
    expect(script).toContain("PINNED_COMMIT");
    expect(script).not.toMatch(/sys\.path\.insert\(0, str\(ROOT/);
  });

  it("exercises the builder: accepted and refused requests", () => {
    const accepted = fixture.cases.filter((c) => c.expected.doc).length;
    const refused = fixture.cases.filter((c) => c.expected.error).length;
    expect(accepted).toBeGreaterThanOrEqual(8);
    expect(refused).toBeGreaterThanOrEqual(3);
  });
});
