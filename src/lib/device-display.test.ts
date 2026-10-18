import { describe, it, expect } from "vitest";
import {
  blockedHint,
  lastActiveLabel,
  permissionChip,
  preferencesSummary,
} from "./device-display";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("lastActiveLabel", () => {
  it("reads naturally at each scale", () => {
    expect(lastActiveLabel(ago(60_000), NOW)).toBe("Active now");
    expect(lastActiveLabel(ago(20 * 60_000), NOW)).toBe(
      "Active 20 minutes ago",
    );
    expect(lastActiveLabel(ago(3_600_000), NOW)).toBe("Active 1 hour ago");
    expect(lastActiveLabel(ago(5 * 3_600_000), NOW)).toBe("Active 5 hours ago");
    expect(lastActiveLabel(ago(86_400_000), NOW)).toBe("Active 1 day ago");
    expect(lastActiveLabel(ago(3 * 86_400_000), NOW)).toBe("Active 3 days ago");
    expect(lastActiveLabel(ago(90 * 86_400_000), NOW)).toBe(
      "Active 2026-07-19",
    );
  });
  it("never goes negative or throws on a bad date", () => {
    expect(lastActiveLabel(new Date(NOW + 5000).toISOString(), NOW)).toBe(
      "Active now",
    );
    expect(lastActiveLabel("nope", NOW)).toBe("Active recently");
  });
});

describe("permission chips", () => {
  it("says what the device has decided", () => {
    expect(
      permissionChip("geolocation", { state: "granted", changedAt: 1 }),
    ).toBe("Location allowed");
    expect(
      permissionChip("geolocation", { state: "denied", changedAt: 1 }),
    ).toBe("Location blocked");
    expect(
      permissionChip("geolocation", { state: "dismissed", changedAt: 1 }),
    ).toBe("Location not now");
    expect(permissionChip("notifications", null)).toBe(
      "Notifications not asked",
    );
  });
  it("explains a block, and only a block", () => {
    expect(blockedHint({ state: "denied", changedAt: 1 })).toContain(
      "browser settings",
    );
    expect(blockedHint({ state: "granted", changedAt: 1 })).toBeNull();
    expect(blockedHint(null)).toBeNull();
  });
});

describe("preferencesSummary", () => {
  const base = {
    theme: "system",
    selectedActivities: [] as string[],
    savedLocations: [] as string[],
    selectedForecastModel: "best_match",
    homeLocation: null,
  };
  it("summarises with correct plurals", () => {
    expect(preferencesSummary(base)).toBe(
      "System theme · 0 saved places · 0 activities",
    );
    expect(
      preferencesSummary({
        ...base,
        theme: "dark",
        savedLocations: ["a"],
        selectedActivities: ["x", "y"],
      }),
    ).toBe("Dark theme · 1 saved place · 2 activities");
    expect(preferencesSummary({ ...base, theme: "light" })).toContain(
      "Light theme",
    );
  });
});
