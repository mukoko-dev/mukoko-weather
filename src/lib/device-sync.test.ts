import { describe, it, expect, vi } from "vitest";
import {
  DEVICE_SYNC_INTERVAL_MS,
  buildDeviceReport,
  syncDevice,
  type DeviceSyncDeps,
} from "./device-sync";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function deps(over: Partial<DeviceSyncDeps> = {}): DeviceSyncDeps & {
  fetch: ReturnType<typeof vi.fn>;
  writeSyncedAt: ReturnType<typeof vi.fn>;
} {
  return {
    now: () => 10 * DEVICE_SYNC_INTERVAL_MS,
    deviceId: () => "11111111-2222-4333-8444-555555555555",
    userAgent: IPHONE,
    standalone: true,
    state: () => ({
      v: 1,
      geolocation: { state: "granted", changedAt: 5 },
      notifications: null,
    }),
    preferences: () => ({
      theme: "dark",
      selectedActivities: ["braai"],
      savedLocations: ["harare"],
      selectedForecastModel: "best_match",
      homeLocation: null,
    }),
    readSyncedAt: () => null,
    writeSyncedAt: vi.fn(),
    fetch: vi.fn(async () => new Response("{}", { status: 200 })),
    ...over,
  } as never;
}

describe("buildDeviceReport", () => {
  it("is coarse: label, platform, permission states, preferences", () => {
    const report = buildDeviceReport(deps());
    expect(report).toMatchObject({
      name: "Safari on iOS",
      platform: "web_safari",
      formFactor: "phone",
      standalone: true,
      permissions: {
        geolocation: { state: "granted", changedAt: 5 },
        notifications: null,
      },
      preferences: { theme: "dark", forecastModel: "best_match" },
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain("Mozilla");
    expect(json).not.toMatch(/"lat"|"lon"|"ip"|"userAgent"/);
  });
});

describe("syncDevice state machine", () => {
  it("first run: reports, records the try, says synced", async () => {
    const d = deps();
    expect(await syncDevice(d)).toBe("synced");
    expect(d.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toBe("/api/devices");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(d.writeSyncedAt).toHaveBeenCalledWith(d.now());
  });

  it("skips within the hour, runs after it, and force overrides", async () => {
    const now = 10 * DEVICE_SYNC_INTERVAL_MS;
    const recent = deps({ readSyncedAt: () => now - 1000 });
    expect(await syncDevice(recent)).toBe("skipped");
    expect(recent.fetch).not.toHaveBeenCalled();
    const stale = deps({ readSyncedAt: () => now - DEVICE_SYNC_INTERVAL_MS });
    expect(await syncDevice(stale)).toBe("synced");
    expect(await syncDevice(recent, { force: true })).toBe("synced");
  });

  it("a clock set back does not freeze reporting", async () => {
    const d = deps({
      readSyncedAt: () => 10 * DEVICE_SYNC_INTERVAL_MS + 99999,
    });
    expect(await syncDevice(d)).toBe("synced");
  });

  it("signed out (401) stays local-only and counts as the hourly try", async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response("{}", { status: 401 })),
    });
    expect(await syncDevice(d)).toBe("local-only");
    expect(d.writeSyncedAt).toHaveBeenCalled();
  });

  it("platform not ready (503 devices_unavailable) stays local-only", async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response("{}", { status: 503 })),
    });
    expect(await syncDevice(d)).toBe("local-only");
  });

  it("offline stays local-only and retries next launch (no timestamp written)", async () => {
    const d = deps({
      fetch: vi.fn(async () => {
        throw new TypeError("network");
      }),
    });
    expect(await syncDevice(d)).toBe("local-only");
    expect(d.writeSyncedAt).not.toHaveBeenCalled();
  });
});
