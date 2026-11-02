/**
 * `tests/fixtures/report-clarify.json` is the oracle for the Rust follow-up
 * questions (`weather_core::ai::clarify`): what the real Python
 * `clarify_report` sent to the model and what it answered. The Python is
 * deleted, so the fixture names the git commit it was generated from and a
 * script regenerates it from that commit. Pinned here so the claim stays
 * reproducible.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const script = readFileSync(
  resolve(ROOT, "scripts/gen_report_clarify_fixtures.py"),
  "utf-8",
);
const fixture = JSON.parse(
  readFileSync(resolve(ROOT, "tests/fixtures/report-clarify.json"), "utf-8"),
) as {
  _generated: { by: string; commit: string; source: string };
  prompts: { reportType: string; place: string | null }[];
  answers: { name: string; expected: { questions: string[] } }[];
  refused: { expected: { error: { status: number; detail: string } } }[];
};

describe("report-clarify fixture", () => {
  it("records the pinned commit it was generated from, and the script agrees", () => {
    expect(fixture._generated.commit).toMatch(/^[0-9a-f]{40}$/);
    const pinned = /^PINNED_COMMIT = "([0-9a-f]{40})"$/m.exec(script);
    expect(pinned?.[1]).toBe(fixture._generated.commit);
    expect(fixture._generated.by).toBe(
      "scripts/gen_report_clarify_fixtures.py",
    );
  });

  it("takes the Python from git at that commit, never from the working tree", () => {
    expect(script).toContain('"archive"');
    expect(script).toContain("PINNED_COMMIT");
    expect(script).not.toMatch(/sys\.path\.insert\(0, str\(ROOT/);
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
