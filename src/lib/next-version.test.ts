import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs the real release-version script (.github/scripts/next-version.sh), the
// same one tag-release.yml calls, so the rollover policy is tested as shipped.
const SCRIPT = path.resolve(process.cwd(), ".github/scripts/next-version.sh");

function run(base: string, bump: string, version = "") {
  const r = spawnSync("bash", [SCRIPT, base, bump, version], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("next-version.sh rollover policy", () => {
  it.each([
    ["v0.11.8", "patch", "v0.11.9"],
    ["v0.11.98", "patch", "v0.11.99"],
    ["v0.11.99", "patch", "v0.12.0"],
    ["v0.12.0", "minor", "v0.13.0"],
    ["v0.12.57", "minor", "v0.13.0"],
    ["v0.998.99", "patch", "v0.999.0"],
    ["v0.999.5", "patch", "v0.999.6"],
    ["v0.11.5", "major", "v1.0.0"],
    ["v1.4.99", "major", "v2.0.0"],
    ["v1.4.99", "patch", "v1.5.0"],
    ["", "patch", "v0.0.1"],
  ])("%s + %s -> %s", (base, bump, want) => {
    expect(run(base, bump)).toMatchObject({ code: 0, out: want });
  });

  it("refuses a minor bump past 999 and asks for a manual major", () => {
    const r = run("v0.999.5", "minor");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/::error::.*manual major/);
  });

  it("refuses a patch rollover past minor 999 and asks for a manual major", () => {
    const r = run("v0.999.99", "patch");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/::error::.*manual major/);
  });

  it("rejects an unknown bump", () => {
    expect(run("v0.1.0", "bogus").code).toBe(1);
  });

  it("rejects a malformed latest tag", () => {
    expect(run("v0.1.0-rc.1", "patch").code).toBe(1);
  });
});

describe("next-version.sh explicit version", () => {
  it.each([
    ["v0.11.5", "v0.11.6"],
    ["v0.11.99", "v0.12.0"],
    ["v0.11.5", "v0.13.0"],
    ["v0.11.5", "v1.0.0"],
    ["v0.11.5", "v0.999.99"],
  ])("accepts %s -> %s", (base, version) => {
    expect(run(base, "patch", version)).toMatchObject({ code: 0, out: version });
  });

  it.each([
    ["v0.11.5", "v0.11.100", /PATCH must be 0-99/],
    ["v0.11.5", "v0.1000.0", /MINOR must be 0-999/],
    ["v0.11.5", "v0.11.5", /greater than/],
    ["v0.11.5", "v0.11.4", /greater than/],
    ["v0.11.5", "v0.10.99", /greater than/],
    ["v1.0.0", "v0.999.99", /greater than/],
    ["v0.11.5", "v0.11.6-rc.1", /vX\.Y\.Z/],
    ["v0.11.5", "0.11.6", /vX\.Y\.Z/],
    ["v0.11.5", "v0.11.06", /vX\.Y\.Z/],
  ])("rejects %s -> %s", (base, version, msg) => {
    const r = run(base, "patch", version);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(msg);
  });

  it("an explicit version overrides the bump", () => {
    expect(run("v0.11.5", "major", "v0.11.6").out).toBe("v0.11.6");
  });
});
