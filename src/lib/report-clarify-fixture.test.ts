/**
 * `tests/fixtures/report-clarify.json` is the oracle for the Rust follow-up
 * questions (`weather_core::ai::clarify`): what the real Python
 * `clarify_report` sent to the model and what it answered. The Python and the
 * script that ran it (`scripts/gen_report_clarify_fixtures.py`) are deleted
 * (#333), so the fixture is now the pinned truth. Its header names the git
 * commit the Python was taken from: `git show <commit>:api/py/_reports.py`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const fixture = JSON.parse(
  readFileSync(resolve(ROOT, "tests/fixtures/report-clarify.json"), "utf-8"),
) as {
  _generated: { by: string; commit: string; source: string };
  prompts: { reportType: string; place: string | null }[];
  answers: { name: string; expected: { questions: string[] } }[];
  refused: { expected: { error: { status: number; detail: string } } }[];
};

describe("report-clarify fixture", () => {
  it("records the commit of the Python it was generated from", () => {
    expect(fixture._generated.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture._generated.by).toBe(
      "scripts/gen_report_clarify_fixtures.py",
    );
    expect(fixture._generated.source).toBe("api/py/_reports.py clarify_report");
  });

  it("is authoritative: the oracle Python and its generator are gone", () => {
    expect(existsSync(resolve(ROOT, "api"))).toBe(false);
    expect(
      existsSync(resolve(ROOT, "scripts/gen_report_clarify_fixtures.py")),
    ).toBe(false);
  });

  it("covers every report type, the failures and the refusals", () => {
    const types = new Set(fixture.prompts.map((p) => p.reportType));
    expect(types.size).toBeGreaterThanOrEqual(13);
    expect(fixture.answers.length).toBeGreaterThanOrEqual(20);
    for (const refused of fixture.refused) {
      expect(refused.expected.error.status).toBe(400);
      expect(refused.expected.error.detail).toBe("Invalid report type");
    }
  });
});
