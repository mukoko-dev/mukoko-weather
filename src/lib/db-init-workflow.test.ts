/**
 * .github/workflows/db-init.yml — runs the seed sync after mukoko-weather's
 * production deploys only, and never two at once.
 *
 * The environment names below are the real ones Vercel and our own Workers
 * deploy job have reported to this repo's GitHub deployments API. Two Vercel
 * projects deploy from this repo, so a "Production" prefix match would also
 * seed after a station-console deploy.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(__dirname, "../../.github/workflows/db-init.yml"),
  "utf-8",
);

// Every environment name seen on this repo's deployments (en dash U+2013).
const REAL_ENVIRONMENTS = [
  "Production – mukoko-weather",
  "Production – mukoko-station-console",
  "Preview – mukoko-weather",
  "Preview – mukoko-station-console",
  "workers-production",
];

/** The environment literal the job's `if:` compares against. */
function matchedEnvironment(): string {
  const m = workflow.match(
    /github\.event\.deployment\.environment == '([^']+)'/,
  );
  if (!m) throw new Error("db-init.yml has no exact environment comparison");
  return m[1];
}

describe("db-init.yml — which deployments run the seed", () => {
  it("compares the environment exactly, never by prefix", () => {
    expect(workflow).not.toMatch(
      /startsWith\(\s*github\.event\.deployment\.environment/,
    );
    expect(matchedEnvironment()).toBe("Production – mukoko-weather");
  });

  it("matches exactly one real environment: mukoko-weather production", () => {
    const env = matchedEnvironment();
    const matches = REAL_ENVIRONMENTS.filter((name) => name === env);
    expect(matches).toEqual(["Production – mukoko-weather"]);
  });

  it("uses the en dash Vercel sends, not a hyphen", () => {
    expect(matchedEnvironment()).toContain("–");
  });

  it("still requires a successful deployment", () => {
    expect(workflow).toMatch(
      /github\.event\.deployment_status\.state == 'success'/,
    );
  });
});

describe("db-init.yml — concurrency", () => {
  it("serialises seeds and never cancels one in flight", () => {
    expect(workflow).toMatch(
      /concurrency:\s*\n\s+group: db-init-production\s*\n\s+cancel-in-progress: false/,
    );
    expect(workflow).not.toMatch(/cancel-in-progress: true/);
  });

  it("puts the group on the job, so skipped preview runs never join it", () => {
    // Job-level keys are indented four spaces under `jobs.db-init`.
    expect(workflow).toMatch(
      /\n {4}concurrency:\n {6}group: db-init-production/,
    );
    expect(workflow).not.toMatch(/^concurrency:/m);
  });
});
