/**
 * `tests/fixtures/report-submit.json` is the oracle for the Rust report builder:
 * what the real Python `submit_report` stored. The Python and the script that
 * ran it (`scripts/gen_report_submit_fixtures.py`) are deleted (#333), so the
 * fixture is now the pinned truth. Its header names the git commit the Python
 * was taken from, so the claim stays reproducible from the repository history:
 * `git show <commit>:api/py/_reports.py`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const fixture = JSON.parse(
  readFileSync(resolve(ROOT, "tests/fixtures/report-submit.json"), "utf-8"),
) as {
  _generated: { by: string; commit: string; source: string };
  ip: string;
  cases: { name: string; expected: { error?: unknown; doc?: unknown } }[];
};

describe("report-submit fixture", () => {
  it("records the commit of the Python it was generated from", () => {
    expect(fixture._generated.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture._generated.by).toBe("scripts/gen_report_submit_fixtures.py");
    expect(fixture._generated.source).toBe("api/py/_reports.py submit_report");
  });

  it("is authoritative: the oracle Python and its generator are gone", () => {
    expect(existsSync(resolve(ROOT, "api"))).toBe(false);
    expect(
      existsSync(resolve(ROOT, "scripts/gen_report_submit_fixtures.py")),
    ).toBe(false);
  });

  it("exercises the builder: accepted and refused requests", () => {
    const accepted = fixture.cases.filter((c) => c.expected.doc).length;
    const refused = fixture.cases.filter((c) => c.expected.error).length;
    expect(accepted).toBeGreaterThanOrEqual(8);
    expect(refused).toBeGreaterThanOrEqual(3);
  });
});
