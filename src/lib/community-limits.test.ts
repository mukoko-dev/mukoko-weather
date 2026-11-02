/**
 * The hourly limits on the places Worker's community writes (a report, a fresh
 * device profile) go through the ONE guarded statement (`budget::SPEND_SQL`),
 * not a count followed by an insert. Parallel cold requests all read the same
 * count in the second form and all pass. The Rust rules are tested natively
 * (`weather_core::budget`, `weather_core::community`); this pins the wiring.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const PLACES = resolve(__dirname, "../../workers/places/src");
const read = (file: string) => readFileSync(resolve(PLACES, file), "utf-8");

describe("places Worker community writes", () => {
  it("has no count-then-insert limiter left", () => {
    expect(existsSync(resolve(PLACES, "limits.rs"))).toBe(false);
    expect(read("lib.rs")).not.toMatch(/^mod limits;/m);
    // The only file that touches rate_events is the budget runner, and its
    // one INSERT is the guarded statement from weather_core::budget.
    for (const file of readdirSync(PLACES).filter((f) => f.endsWith(".rs"))) {
      const text = read(file);
      if (file === "budget.rs") continue;
      expect(text, file).not.toMatch(/INSERT INTO rate_events/);
      expect(text, file).not.toMatch(/FROM rate_events/);
    }
    expect(read("budget.rs")).toContain("budget::SPEND_SQL");
    expect(read("budget.rs")).not.toMatch(/INSERT INTO rate_events/);
  });

  it("takes a report's budget with the report action and answers 429 or 503 from the core mapping", () => {
    const reports = read("reports.rs");
    expect(reports).toContain("budget::take(");
    expect(reports).toContain("Action::WeatherReport");
    expect(reports).toContain("limit_refusal(decision, Limited::Reports)");
    // The budget is taken before the place is looked up or anything is stored.
    expect(reports.indexOf("Action::WeatherReport")).toBeLessThan(
      reports.indexOf("crate::find_location"),
    );
    expect(reports.indexOf("Action::WeatherReport")).toBeLessThan(
      reports.indexOf('"/reports", Some'),
    );
  });

  it("takes a fresh device profile's budget the same way, before the profile is written", () => {
    const devices = read("community.rs");
    expect(devices).toContain("budget::take(");
    expect(devices).toContain("Action::DeviceCreate");
    expect(devices).toContain("limit_refusal(decision, Limited::Devices)");
    expect(devices.indexOf("Action::DeviceCreate")).toBeLessThan(
      devices.indexOf("bridge::call("),
    );
  });
});
