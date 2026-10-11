import { describe, expect, it, vi } from "vitest";
import { clickAction, notificationFor, safeTarget } from "./sw-logic";
import {
  enablePush,
  pushApi,
  pushState,
  urlBase64ToUint8Array,
  type PushEnv,
} from "./client";

const base: PushEnv = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: "default",
  isIos: false,
  isStandalone: false,
};

describe("safeTarget", () => {
  it("allows same-origin paths only", () => {
    expect(safeTarget("/harare")).toBe("/harare");
    expect(safeTarget("//evil.example")).toBe("/");
    expect(safeTarget("https://evil.example")).toBe("/");
    expect(safeTarget("/\\evil")).toBe("/");
    expect(safeTarget(undefined)).toBe("/");
  });
});

describe("notificationFor", () => {
  const payload = {
    v: 1,
    kind: "frost",
    slug: "harare",
    night: "2026-07-10",
    title: "Frost alert for Harare",
    body: "Frost risk.",
    url: "/harare",
  };
  it("shows the payload, tagged per place+kind+night", () => {
    const n = notificationFor(JSON.stringify(payload));
    expect(n.title).toBe("Frost alert for Harare");
    expect(n.options.tag).toBe("frost:harare:2026-07-10");
    expect(n.options.data.url).toBe("/harare");
  });
  it("never throws: bad data falls back to a generic notification", () => {
    for (const raw of [
      undefined,
      null,
      "not json",
      "{}",
      JSON.stringify({ ...payload, v: 2 }),
      JSON.stringify({ ...payload, title: "" }),
    ]) {
      expect(notificationFor(raw).title).toBe("mukoko weather");
    }
  });
  it("cannot be pointed at another origin", () => {
    expect(
      notificationFor({ ...payload, url: "https://evil.example" }).options.data
        .url,
    ).toBe("/");
  });
});

describe("clickAction", () => {
  const origin = "https://weather.mukoko.com";
  it("focuses an open window of the origin", () => {
    const w = { url: `${origin}/explore`, focus: vi.fn() };
    const a = clickAction(
      { url: "/harare" },
      [{ url: "https://other.example/", focus: vi.fn() }, w],
      origin,
    );
    expect(a).toEqual({ kind: "focus", window: w, url: `${origin}/harare` });
  });
  it("opens a window when none is open, and ignores hostile targets", () => {
    expect(clickAction({ url: "//evil.example" }, [], origin)).toEqual({
      kind: "open",
      url: `${origin}/`,
    });
  });
});

describe("pushState", () => {
  it("covers every platform case", () => {
    expect(pushState(base)).toBe("available");
    expect(pushState({ ...base, permission: "granted" })).toBe("granted");
    expect(pushState({ ...base, permission: "denied" })).toBe("denied");
    expect(pushState({ ...base, hasPushManager: false })).toBe("unsupported");
    expect(pushState({ ...base, isIos: true })).toBe("needs-install");
    expect(pushState({ ...base, isIos: true, isStandalone: true })).toBe(
      "available",
    );
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes unpadded base64url", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
  });
});

describe("enablePush", () => {
  const sub = {
    toJSON: () => ({
      endpoint: "https://fcm.googleapis.com/x",
      keys: { p256dh: "a", auth: "b" },
    }),
    unsubscribe: vi.fn(),
  };
  function deps(over: Partial<Parameters<typeof enablePush>[0]> = {}) {
    const api = {
      config: vi.fn().mockResolvedValue({ vapid_public_key: "AQID" }),
      subscribe: vi.fn().mockResolvedValue({ id: "i" }),
    } as never;
    const registration = vi.fn().mockResolvedValue({
      pushManager: {
        getSubscription: async () => null,
        subscribe: vi.fn().mockResolvedValue(sub),
      },
    });
    return {
      env: base,
      requestPermission: vi.fn().mockResolvedValue("granted"),
      registration,
      api,
      ...over,
    } as Parameters<typeof enablePush>[0];
  }
  it("asks, subscribes and registers", async () => {
    const d = deps();
    expect(await enablePush(d)).toBe("enabled");
    expect(d.requestPermission).toHaveBeenCalled();
    expect(
      (d.api as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe,
    ).toHaveBeenCalled();
  });
  it("does not ask when unsupported, needs install or already denied", async () => {
    for (const env of [
      { ...base, hasPushManager: false },
      { ...base, isIos: true },
      { ...base, permission: "denied" as const },
    ]) {
      const d = deps({ env });
      expect(["unsupported", "denied"]).toContain(await enablePush(d));
      expect(d.requestPermission).not.toHaveBeenCalled();
    }
  });
  it("reports a refusal and never throws on failure", async () => {
    expect(
      await enablePush(
        deps({ requestPermission: vi.fn().mockResolvedValue("denied") }),
      ),
    ).toBe("denied");
    expect(
      await enablePush(
        deps({ registration: vi.fn().mockRejectedValue(new Error("x")) }),
      ),
    ).toBe("error");
  });
});

describe("pushApi", () => {
  it("sends the subscription with the owner's session only (no ids in the body)", async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "abc" }), { status: 200 }),
      );
    const api = pushApi("/api/push", f);
    await api.subscribe(
      {
        endpoint: "https://fcm.googleapis.com/x",
        keys: { p256dh: "a", auth: "b" },
      },
      "android-chrome",
    );
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/push/subscriptions");
    expect(init.method).toBe("PUT");
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual([
      "endpoint",
      "keys",
      "platform",
    ]);
  });
  it("throws a coded error on non-2xx", async () => {
    const api = pushApi(
      "/api/push",
      vi.fn().mockResolvedValue(new Response("", { status: 401 })),
    );
    await expect(api.config()).rejects.toThrow("push_api_401");
  });
});
