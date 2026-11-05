import { describe, expect, it } from "vitest";
import {
  COMING_SOON_CHANNELS,
  DELIVERY_BEST_EFFORT,
  IN_APP_DELIVERY,
  permissionToRecord,
  pushRow,
  type PushRowInput,
} from "./notification-delivery";
import type { PushEnv } from "./push/client";

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: "default",
  isIos: false,
  isStandalone: false,
  ...over,
});

const row = (over: Partial<PushRowInput> = {}) =>
  pushRow({
    env: env(),
    serverReady: true,
    subscribed: false,
    ...over,
  });

describe("the delivery channels", () => {
  it("says in the app is always on and delivery is best effort", () => {
    expect(IN_APP_DELIVERY.title).toBe("In the app");
    expect(IN_APP_DELIVERY.status).toBe("Always on");
    expect(IN_APP_DELIVERY.detail).toContain("best effort");
    expect(DELIVERY_BEST_EFFORT).toBe("Delivery is best effort.");
  });

  it("lists Campfire, nothing else, as coming soon (we build our own messaging, not Telegram)", () => {
    expect(COMING_SOON_CHANNELS.map((c) => c.title)).toEqual(["Campfire"]);
  });
});

describe("pushRow: an honest state for every case", () => {
  it("checking, before the browser has been read", () => {
    const r = row({ env: null });
    expect(r.status).toBe("checking");
    expect(r.action).toBeNull();
  });

  it("unsupported: no push in this browser, no button", () => {
    for (const over of [
      { hasServiceWorker: false },
      { hasPushManager: false },
      { hasNotification: false, permission: undefined },
    ]) {
      const r = row({ env: env(over) });
      expect(r.status, JSON.stringify(over)).toBe("unsupported");
      expect(r.action).toBeNull();
      expect(r.detail).toContain("Alerts still appear in the app");
    }
  });

  it("needs-install: iOS in a Safari tab is told to add to the Home Screen", () => {
    const r = row({ env: env({ isIos: true, isStandalone: false }) });
    expect(r.status).toBe("needs-install");
    expect(r.detail).toContain("Add to Home Screen");
    expect(r.action).toBeNull();
    // Installed on iOS is a normal browser for this purpose.
    expect(row({ env: env({ isIos: true, isStandalone: true }) }).status).toBe(
      "available",
    );
  });

  it("denied: blocked in the browser, no button, says where to change it", () => {
    const r = row({ env: env({ permission: "denied" }) });
    expect(r.status).toBe("denied");
    expect(r.state).toBe("Blocked");
    expect(r.action).toBeNull();
    expect(r.detail).toContain("browser");
  });

  it("not-switched-on: the alert service is not live, so no button is shown", () => {
    const r = row({ serverReady: false });
    expect(r.status).toBe("not-switched-on");
    expect(r.state).toBe("Not switched on yet");
    expect(r.action).toBeNull();
    expect(r.actionLabel).toBeNull();
    // Even with permission already granted, nothing can be sent yet.
    expect(
      row({ serverReady: false, env: env({ permission: "granted" }) }).action,
    ).toBeNull();
  });

  it("puts what the device can do before the server's readiness", () => {
    expect(
      row({ serverReady: false, env: env({ permission: "denied" }) }).status,
    ).toBe("denied");
    expect(
      row({ serverReady: false, env: env({ hasPushManager: false }) }).status,
    ).toBe("unsupported");
  });

  it("available: offers to switch on, never calls it guaranteed", () => {
    const r = row();
    expect(r).toMatchObject({
      status: "available",
      action: "enable",
      actionLabel: "Switch on push",
    });
    expect(r.detail).toContain("best effort");
    expect(r.detail).not.toMatch(/guarantee/i);
    expect(row({ env: env({ permission: "granted" }) }).action).toBe("enable");
  });

  it("enabled: subscribed with permission granted offers to switch off", () => {
    const r = row({ env: env({ permission: "granted" }), subscribed: true });
    expect(r).toMatchObject({
      status: "enabled",
      state: "On",
      action: "disable",
      actionLabel: "Switch off push",
    });
    expect(r.detail).toContain("best effort");
    // A subscription without permission is not "on".
    expect(
      row({ env: env({ permission: "default" }), subscribed: true }).status,
    ).toBe("available");
  });

  it("error: says it did not work and offers to try again", () => {
    const r = row({ lastResult: "error" });
    expect(r).toMatchObject({
      status: "error",
      action: "enable",
      actionLabel: "Try again",
    });
  });

  it("dismissed: the prompt was closed, so nothing changed, and it can be asked again", () => {
    const r = row({ lastResult: "dismissed" });
    expect(r.status).toBe("available");
    expect(r.detail).toContain("nothing changed");
    expect(r.action).toBe("enable");
  });

  it("never offers a button whose action does nothing", () => {
    const cases: Partial<PushRowInput>[] = [
      { env: null },
      { serverReady: false },
      { env: env({ hasServiceWorker: false }) },
      { env: env({ isIos: true }) },
      { env: env({ permission: "denied" }) },
    ];
    for (const c of cases) {
      const r = row(c);
      expect(r.action, r.status).toBeNull();
      expect(r.actionLabel, r.status).toBeNull();
    }
  });
});

describe("permissionToRecord", () => {
  it("maps the outcome to the device state's vocabulary", () => {
    expect(permissionToRecord("enabled")).toBe("granted");
    expect(permissionToRecord("denied")).toBe("denied");
    expect(permissionToRecord("dismissed")).toBe("dismissed");
    for (const other of ["needs-install", "unsupported", "error"] as const) {
      expect(permissionToRecord(other)).toBeNull();
    }
  });
});
