import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  QUIET_HOUR_CHOICES,
  QUIET_NIGHT,
  countEnabled,
  enabledKinds,
  filterAlertsByPrefs,
  isQuietNow,
  mergeNotificationPrefs,
  prefsSummary,
  quietEndPatch,
  quietLabel,
  quietModeOf,
  quietSwitchPatch,
  sanitiseNotificationPrefs,
  type NotificationPrefs,
} from "./notification-prefs";

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...over,
});

describe("defaults", () => {
  it("has all four kinds on in the app and quiet hours off", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      frost: true,
      lightning: true,
      wildfire: true,
      flooding: true,
      quietStart: null,
      quietEnd: null,
    });
    expect(quietModeOf(DEFAULT_NOTIFICATION_PREFS)).toBe("off");
    expect(quietLabel(DEFAULT_NOTIFICATION_PREFS)).toBe("Off");
  });
});

describe("sanitiseNotificationPrefs", () => {
  it("turns anything unreadable into the defaults", () => {
    for (const bad of [undefined, null, 7, "x", [], {}]) {
      expect(sanitiseNotificationPrefs(bad)).toEqual(
        DEFAULT_NOTIFICATION_PREFS,
      );
    }
  });

  it("keeps real booleans, and treats a non-boolean kind as on", () => {
    expect(
      sanitiseNotificationPrefs({ frost: false, lightning: "no", wildfire: 0 }),
    ).toMatchObject({
      frost: false,
      lightning: true,
      wildfire: true,
      flooding: true,
    });
  });

  it("keeps quiet hours only as two different whole hours between 0 and 23", () => {
    expect(
      sanitiseNotificationPrefs({ quietStart: 22, quietEnd: 6 }),
    ).toMatchObject({ quietStart: 22, quietEnd: 6 });
    for (const bad of [
      { quietStart: 22, quietEnd: null },
      { quietStart: null, quietEnd: 6 },
      { quietStart: 5, quietEnd: 5 },
      { quietStart: 24, quietEnd: 6 },
      { quietStart: -1, quietEnd: 6 },
      { quietStart: 22.5, quietEnd: 6 },
      { quietStart: "22", quietEnd: "6" },
    ]) {
      expect(sanitiseNotificationPrefs(bad)).toMatchObject({
        quietStart: null,
        quietEnd: null,
      });
    }
  });

  it("allows midnight as an hour", () => {
    expect(
      sanitiseNotificationPrefs({ quietStart: 0, quietEnd: 7 }),
    ).toMatchObject({ quietStart: 0, quietEnd: 7 });
  });
});

describe("merge, kinds and filter", () => {
  it("applies a patch and sanitises the result", () => {
    expect(mergeNotificationPrefs(prefs(), { frost: false }).frost).toBe(false);
    expect(
      mergeNotificationPrefs(prefs(), { quietStart: 3, quietEnd: 3 }),
    ).toMatchObject({ quietStart: null, quietEnd: null });
  });

  it("lists the enabled kinds in the settings' order and counts them", () => {
    const p = prefs({ lightning: false, flooding: false });
    expect(enabledKinds(p)).toEqual(["frost", "wildfire"]);
    expect(countEnabled(p)).toBe(2);
    expect(prefsSummary(p)).toBe("2 of 4 on");
    expect(prefsSummary(prefs())).toBe("4 of 4 on");
    expect(
      prefsSummary(
        prefs({
          frost: false,
          lightning: false,
          wildfire: false,
          flooding: false,
        }),
      ),
    ).toBe("All alerts off");
  });

  it("keeps only the alerts of kinds that are on", () => {
    const alerts = [
      { kind: "frost" as const, id: 1 },
      { kind: "lightning" as const, id: 2 },
      { kind: "flooding" as const, id: 3 },
    ];
    expect(
      filterAlertsByPrefs(alerts, prefs({ lightning: false })).map((a) => a.id),
    ).toEqual([1, 3]);
    expect(filterAlertsByPrefs(alerts, prefs())).toHaveLength(3);
    expect(
      filterAlertsByPrefs(
        alerts,
        prefs({ frost: false, lightning: false, flooding: false }),
      ),
    ).toEqual([]);
  });
});

describe("quiet hours", () => {
  const night = prefs({ quietStart: 22, quietEnd: 6 });
  /** A moment whose hour is `hour` on a clock at `offset` seconds from UTC. */
  const at = (hour: number, offset = 0, minute = 0) =>
    new Date(Date.UTC(2026, 6, 10, hour, minute) - offset * 1000);

  it("reads the mode and its label", () => {
    expect(quietModeOf(night)).toBe("night");
    expect(quietLabel(night)).toBe("22:00 to 06:00");
    expect(quietModeOf(prefs({ quietStart: 21, quietEnd: 5 }))).toBe("custom");
    expect(quietLabel(prefs({ quietStart: 21, quietEnd: 5 }))).toBe(
      "21:00 to 05:00",
    );
    expect(QUIET_NIGHT).toEqual({ start: 22, end: 6 });
  });

  it("is never quiet when off", () => {
    for (let h = 0; h < 24; h++) {
      expect(isQuietNow(DEFAULT_NOTIFICATION_PREFS, at(h), 0)).toBe(false);
    }
  });

  it("covers a window that runs over midnight", () => {
    expect(isQuietNow(night, at(21, 0, 59), 0)).toBe(false);
    expect(isQuietNow(night, at(22), 0)).toBe(true);
    expect(isQuietNow(night, at(23, 0, 30), 0)).toBe(true);
    expect(isQuietNow(night, at(0), 0)).toBe(true);
    expect(isQuietNow(night, at(5, 0, 59), 0)).toBe(true);
    expect(isQuietNow(night, at(6), 0)).toBe(false);
    expect(isQuietNow(night, at(12), 0)).toBe(false);
  });

  it("covers a window inside one day", () => {
    const nap = prefs({ quietStart: 13, quietEnd: 15 });
    expect(isQuietNow(nap, at(12, 0, 59), 0)).toBe(false);
    expect(isQuietNow(nap, at(13), 0)).toBe(true);
    expect(isQuietNow(nap, at(14, 0, 59), 0)).toBe(true);
    expect(isQuietNow(nap, at(15), 0)).toBe(false);
  });

  it("reads the hour on the person's own clock, not UTC", () => {
    // 20:30 UTC is 22:30 at UTC+2: quiet there, not at UTC.
    const instant = at(20, 0, 30);
    expect(isQuietNow(night, instant, 7200)).toBe(true);
    expect(isQuietNow(night, instant, 0)).toBe(false);
    // The same instant at UTC-5 is 15:30.
    expect(isQuietNow(night, instant, -18000)).toBe(false);
  });

  it("switching on gives the Night preset and off clears both hours", () => {
    expect(quietSwitchPatch(true)).toEqual({ quietStart: 22, quietEnd: 6 });
    expect(quietSwitchPatch(false)).toEqual({
      quietStart: null,
      quietEnd: null,
    });
  });

  it("never lets the two ends meet: picking the other end's hour moves it one hour", () => {
    expect(quietEndPatch(night, "start", 9)).toEqual({
      quietStart: 9,
      quietEnd: 6,
    });
    expect(quietEndPatch(night, "start", 6)).toEqual({
      quietStart: 6,
      quietEnd: 7,
    });
    expect(quietEndPatch(night, "end", 23)).toEqual({
      quietStart: 22,
      quietEnd: 23,
    });
    expect(quietEndPatch(night, "end", 22)).toEqual({
      quietStart: 21,
      quietEnd: 22,
    });
    // Wraps around midnight.
    expect(
      quietEndPatch(prefs({ quietStart: 3, quietEnd: 0 }), "start", 0),
    ).toEqual({ quietStart: 0, quietEnd: 1 });
    expect(
      quietEndPatch(prefs({ quietStart: 0, quietEnd: 5 }), "end", 0),
    ).toEqual({ quietStart: 23, quietEnd: 0 });
    // A bad hour changes nothing.
    expect(quietEndPatch(night, "end", 99)).toEqual({
      quietStart: 22,
      quietEnd: 6,
    });
  });

  it("every patch it makes survives sanitising", () => {
    for (let h = 0; h < 24; h++) {
      for (const end of ["start", "end"] as const) {
        const patch = quietEndPatch(night, end, h);
        const next = mergeNotificationPrefs(night, patch);
        expect(next.quietStart, `${end} ${h}`).not.toBeNull();
        expect(next.quietEnd).not.toBeNull();
        expect(next.quietStart).not.toBe(next.quietEnd);
      }
    }
  });

  it("offers 24 hour choices, 00:00 to 23:00", () => {
    expect(QUIET_HOUR_CHOICES).toHaveLength(24);
    expect(QUIET_HOUR_CHOICES[0]).toEqual({ value: 0, label: "00:00" });
    expect(QUIET_HOUR_CHOICES[23]).toEqual({ value: 23, label: "23:00" });
  });
});
