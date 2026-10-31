/**
 * Devices section of /profile: structure, accessibility and the rules that
 * keep it honest. Reads the source (this repo's component-test convention).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");
const src = read("ProfileDevices.tsx");
const client = read("../../app/profile/ProfileClient.tsx");

describe("ProfileDevices", () => {
  it("is a labelled grouped-list card in the profile standard", () => {
    expect(src).toContain('<ProfileGroup id="profile-devices" title="Devices"');
    const group = read("ProfileGroup.tsx");
    expect(group).toContain("aria-labelledby={id}");
    expect(group).toContain("guineafowl-heading");
    expect(group).toMatch(/className="guineafowl"/);
  });

  it("sits between organisations and appearance on /profile", () => {
    const order = [
      "<ProfileOrganizations",
      "<ProfileDevices",
      "<ProfileAppearance",
    ].map((n) => client.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("marks This device and offers Sign out only for the others", () => {
    expect(src).toContain("This device");
    expect(src).toContain("{!d.current && (");
    expect(src).toContain("aria-label={`Sign out ${d.label}`}");
  });

  it("signs out through the same-origin JSON DELETE", () => {
    expect(src).toContain('method: "DELETE"');
    expect(src).toContain('"content-type": "application/json"');
    expect(src).toContain("/api/devices/${encodeURIComponent(id)}");
  });

  it("shows permission chips and preferences for this device only (from the local mirror)", () => {
    expect(src).toContain("d.current && local");
    expect(src).toContain('permissionChip("geolocation"');
    expect(src).toContain("blockedHint(");
  });

  it("has loading, empty and error states with roles", () => {
    expect(src).toContain('role="status"');
    expect(src).toContain('<Alert variant="severe"');
    expect(src).toContain('<Alert variant="warning"');
    expect(src).toContain("No signed-in devices found.");
  });

  it("never renders an IP address and reads no clock during render", () => {
    expect(src.toLowerCase()).not.toContain("ipaddress");
    // the clock is read after mount into state, never in the render body
    expect(src).toContain("setNow(Date.now())");
  });

  it("uses fauna classes and tokens, no inline styles or hex", () => {
    expect(src).toContain("impala-sm");
    expect(src).not.toMatch(/style=\{\{/);
    expect(src).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]/);
    expect(src).not.toMatch(/\brounded-(md|lg)\b/);
  });
});
