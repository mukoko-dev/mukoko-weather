/**
 * Every way into the notifications centre, and the hooks behind its honest
 * push row. Structural checks on the sources (the pieces are wired to the
 * store, not to each other).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(__dirname, "../..", file), "utf-8");

describe("entry points", () => {
  it("the group's bell and the phone menu's row open the same centre", () => {
    expect(read("components/layout/NotificationsButton.tsx")).toContain(
      'openNotifications("list")',
    );
    expect(read("components/layout/PhoneMenu.tsx")).toContain(
      "openNotifications()",
    );
  });

  it("every way in opens the one centre the group's bell mounts: nothing else mounts it", () => {
    // The open state is the store's, so a second mount would open two centres
    // (or anchor one to an element that is not drawn). Only the bell mounts it.
    const mounts = [
      "components/layout/Header.tsx",
      "components/layout/AppChrome.tsx",
      "components/layout/QuickActions.tsx",
      "components/layout/PhoneMenu.tsx",
      "components/layout/MobileNav.tsx",
      "components/weather/MyWeatherModal.tsx",
      "app/profile/ProfileClient.tsx",
    ].filter((file) => /<NotificationsCentre\b/.test(read(file)));
    expect(mounts).toEqual([]);
    expect(
      read("components/layout/NotificationsButton.tsx").match(
        /<NotificationsCentre\b/g,
      ),
    ).toHaveLength(1);
  });

  it("the My Weather Settings tab closes itself, then opens the settings (one dialog at a time)", () => {
    const src = read("components/weather/MyWeatherModal.tsx");
    expect(src).toMatch(
      /closeMyWeather\(\);\s*openNotifications\("settings"\);/,
    );
    expect(src).toContain("Notification settings");
  });

  it("the profile has a Notifications row that opens the settings and says how many kinds are on", () => {
    const src = read("app/profile/ProfileClient.tsx");
    expect(src).toContain('label="Notifications"');
    expect(src).toContain('onClick={() => openNotifications("settings")}');
    expect(src).toContain("prefsSummary(notificationPrefs)");
  });

  it("the list links to the settings, and the settings link back", () => {
    const panel = read("components/notifications/NotificationsPanel.tsx");
    expect(panel).toContain("Alert settings");
    const settings = read("components/notifications/NotificationSettings.tsx");
    expect(settings).toContain("Back to alerts");
  });
});

describe("useDevicePush: an honest row, a prompt only after a tap", () => {
  const src = read("lib/use-device-push.ts");

  it("asks the browser for permission only inside the action the button runs", () => {
    expect(src.match(/Notification\.requestPermission\(/g)).toHaveLength(1);
    const action = src.slice(src.indexOf("const onAction"));
    expect(action).toContain(
      "requestPermission: () => Notification.requestPermission()",
    );
    // Never on mount: the effect only reads.
    const effect = src.slice(
      src.indexOf("useEffect"),
      src.indexOf("const row"),
    );
    expect(effect).not.toContain("requestPermission");
    expect(effect).not.toContain("enablePush(");
  });

  it("is switched on by the web_push flag and says nothing is live otherwise", () => {
    expect(src).toContain('getFeatureFlag("web_push")');
    expect(src).toContain(
      "pushRow({ env, serverReady, subscribed, lastResult })",
    );
  });

  it("remembers the permission outcome in the device state", () => {
    expect(src).toContain('recordPermission("notifications", outcome)');
    expect(src).toContain("permissionToRecord(result)");
  });

  it("does nothing while busy or when the row offers nothing", () => {
    expect(src).toContain("if (busy || !env || !row.action) return;");
  });

  it("does not call the alert sender or send preferences: that is the service's job, not this build's", () => {
    expect(src).not.toContain("setPreferences");
    expect(src).not.toMatch(/vapid/i);
  });
});

describe("useMediaQuery", () => {
  const src = read("lib/use-media-query.ts");
  it("is false on the server and during hydration", () => {
    expect(src).toContain("() => false,");
  });
  it("defines the phone layout as below Tailwind's sm", () => {
    expect(src).toContain('PHONE_QUERY = "(max-width: 639px)"');
  });
});

describe("the feature flag", () => {
  it("web_push ships dark with the reason written next to it", () => {
    const flags = read("lib/feature-flags.ts");
    expect(flags).toContain("web_push: false,");
    expect(flags).toContain("Not switched on yet");
  });
});
