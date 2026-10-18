import { describe, expect, it, vi } from "vitest";
import {
  FALLBACK,
  clickAction,
  notificationFor,
  openFromClick,
  resubscribeAfterChange,
  safeTarget,
  showWithFallback,
} from "./sw-logic";
import {
  disablePush,
  enablePush,
  endpointId,
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
  it("keeps path, query and hash of a same-origin target", () => {
    expect(safeTarget("/harare/forecast?x=1#top")).toBe(
      "/harare/forecast?x=1#top",
    );
  });
  it("rejects control characters the URL parser would silently strip", () => {
    for (const bad of [
      "/\t/evil.example",
      "\t//evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "\n//evil.example",
      "/a\u0000b",
      "/a\u007fb",
    ]) {
      expect(safeTarget(bad)).toBe("/");
    }
  });
  it("never resolves to another origin, whatever the encoding", () => {
    for (const hostile of [
      "/%09/evil.example",
      "/%2F%2Fevil.example",
      "//evil",
      "///evil",
      "https://evil",
      "javascript:alert(1)",
      "data:text/html,x",
      "/\\evil",
      "http:evil",
    ]) {
      const out = safeTarget(hostile);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, "https://weather.mukoko.com").origin).toBe(
        "https://weather.mukoko.com",
      );
    }
    expect(safeTarget("javascript:alert(1)")).toBe("/");
    expect(safeTarget("//evil")).toBe("/");
    expect(safeTarget("https://evil")).toBe("/");
    expect(safeTarget("/" + "a".repeat(400))).toBe("/");
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
  it("does not treat a lookalike origin as the same origin", () => {
    const w = { url: `${origin}.evil.example/`, focus: vi.fn() };
    expect(clickAction({ url: "/harare" }, [w], origin).kind).toBe("open");
  });
  it("opens a window when none is open, and ignores hostile targets", () => {
    expect(clickAction({ url: "//evil.example" }, [], origin)).toEqual({
      kind: "open",
      url: `${origin}/`,
    });
  });
});

describe("showWithFallback", () => {
  const n = notificationFor({
    v: 1,
    kind: "frost",
    slug: "harare",
    night: "2026-07-10",
    title: "Frost alert for Harare",
    body: "Frost risk.",
    url: "/harare",
  });
  it("shows the real notification", async () => {
    const show = vi.fn().mockResolvedValue(undefined);
    await showWithFallback({ showNotification: show }, n);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(n.title, n.options);
  });
  it("falls back to the generic notification when showing fails", async () => {
    const show = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad icon"))
      .mockResolvedValueOnce(undefined);
    await showWithFallback({ showNotification: show }, n);
    expect(show).toHaveBeenLastCalledWith(FALLBACK.title, FALLBACK.options);
  });
});

describe("openFromClick", () => {
  const origin = "https://weather.mukoko.com";
  function win(url: string, over: Record<string, unknown> = {}) {
    return {
      url,
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }
  it("focuses first, then navigates, preferring a controlled window", async () => {
    const controlled = win(`${origin}/a`);
    const other = win(`${origin}/b`);
    const order: string[] = [];
    controlled.focus.mockImplementation(async () => void order.push("focus"));
    controlled.navigate.mockImplementation(
      async () => void order.push("navigate"),
    );
    const clients = {
      matchAll: vi.fn(async (o: { includeUncontrolled: boolean }) =>
        o.includeUncontrolled ? [other] : [controlled],
      ),
      openWindow: vi.fn(),
    };
    await openFromClick({ url: "/harare" }, clients, origin);
    expect(order).toEqual(["focus", "navigate"]);
    expect(controlled.navigate).toHaveBeenCalledWith(`${origin}/harare`);
    expect(other.focus).not.toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });
  it("uses an uncontrolled window when none is controlled", async () => {
    const other = win(`${origin}/b`);
    const clients = {
      matchAll: vi.fn(async (o: { includeUncontrolled: boolean }) =>
        o.includeUncontrolled ? [other] : [],
      ),
      openWindow: vi.fn(),
    };
    await openFromClick({ url: "/harare" }, clients, origin);
    expect(other.focus).toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });
  it("opens a window when there is none, or when navigation rejects", async () => {
    const none = {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow: vi.fn(),
    };
    await openFromClick({ url: "//evil" }, none, origin);
    expect(none.openWindow).toHaveBeenCalledWith(`${origin}/`);
    const bad = win(`${origin}/a`, {
      navigate: vi.fn().mockRejectedValue(new Error("x")),
    });
    const clients = {
      matchAll: vi.fn().mockResolvedValue([bad]),
      openWindow: vi.fn(),
    };
    await openFromClick({ url: "/harare" }, clients, origin);
    expect(clients.openWindow).toHaveBeenCalledWith(`${origin}/harare`);
  });
  it("opens a window when matchAll itself rejects", async () => {
    const clients = {
      matchAll: vi.fn().mockRejectedValue(new Error("x")),
      openWindow: vi.fn(),
    };
    await openFromClick({ url: "/harare" }, clients, origin);
    expect(clients.openWindow).toHaveBeenCalledWith(`${origin}/harare`);
  });
});

describe("resubscribeAfterChange", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });
  it("subscribes with the current key and registers the new subscription", async () => {
    const subscribe = vi.fn().mockResolvedValue({
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/n",
        keys: { p256dh: "a", auth: "b" },
      }),
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok({ vapid_public_key: "AQID" }))
      .mockResolvedValueOnce(ok({ id: "i" }));
    expect(
      await resubscribeAfterChange({
        registration: { pushManager: { subscribe } },
        fetchFn,
      }),
    ).toBe(true);
    expect(Array.from(subscribe.mock.calls[0][0].applicationServerKey)).toEqual(
      [1, 2, 3],
    );
    const [url, init] = fetchFn.mock.calls[1];
    expect(url).toBe("/api/push/subscriptions");
    expect(init.method).toBe("PUT");
  });
  it("never throws", async () => {
    expect(
      await resubscribeAfterChange({
        registration: { pushManager: { subscribe: vi.fn() } },
        fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    ).toBe(false);
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
  it("also accepts padded input", () => {
    expect(Array.from(urlBase64ToUint8Array("-_8="))).toEqual([251, 255]);
  });
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
    const cases = [
      [{ ...base, hasPushManager: false }, "unsupported"],
      [{ ...base, isIos: true }, "needs-install"],
      [{ ...base, permission: "denied" as const }, "denied"],
    ] as const;
    for (const [env, want] of cases) {
      const d = deps({ env });
      expect(await enablePush(d)).toBe(want);
      expect(d.requestPermission).not.toHaveBeenCalled();
    }
  });
  it("reports a dismissed prompt separately from a refusal", async () => {
    expect(
      await enablePush(
        deps({ requestPermission: vi.fn().mockResolvedValue("default") }),
      ),
    ).toBe("dismissed");
  });
  describe("existing subscription", () => {
    const vapid = Uint8Array.from([1, 2, 3]); // "AQID"
    function withExisting(key: Uint8Array | null | "absent") {
      const existing = {
        toJSON: () => ({
          endpoint: "https://fcm.googleapis.com/old",
          keys: { p256dh: "a", auth: "b" },
        }),
        unsubscribe: vi.fn().mockResolvedValue(true),
        options:
          key === "absent"
            ? undefined
            : {
                applicationServerKey: key ? (key.buffer as ArrayBuffer) : null,
              },
      };
      const subscribe = vi.fn().mockResolvedValue(sub);
      const d = deps({
        registration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: async () => existing, subscribe },
        }),
      });
      return { d, existing, subscribe };
    }
    it("keeps a subscription made with the current key", async () => {
      const { d, existing, subscribe } = withExisting(vapid.slice());
      expect(await enablePush(d)).toBe("enabled");
      expect(existing.unsubscribe).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
    });
    it("replaces a subscription made with a different key", async () => {
      const { d, existing, subscribe } = withExisting(
        Uint8Array.from([9, 9, 9]),
      );
      expect(await enablePush(d)).toBe("enabled");
      expect(existing.unsubscribe).toHaveBeenCalled();
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(
        Array.from(subscribe.mock.calls[0][0].applicationServerKey),
      ).toEqual([1, 2, 3]);
    });
    it("keeps a subscription whose key the browser does not expose", async () => {
      for (const k of [null, "absent" as const]) {
        const { d, existing } = withExisting(k);
        expect(await enablePush(d)).toBe("enabled");
        expect(existing.unsubscribe).not.toHaveBeenCalled();
      }
    });
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

describe("disablePush", () => {
  function setup(
    sub: unknown,
    unsubscribeApi = vi.fn().mockResolvedValue(undefined),
  ) {
    return {
      deps: {
        registration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: async () => sub },
        }),
        api: { unsubscribe: unsubscribeApi } as never,
      } as Parameters<typeof disablePush>[0],
      unsubscribeApi,
    };
  }
  it("unsubscribes locally then deletes on the server by endpoint hash", async () => {
    const sub = {
      toJSON: () => ({
        endpoint: "https://FCM.googleapis.com:443/fcm/send/AbC",
      }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const { deps: d, unsubscribeApi } = setup(sub);
    expect(await disablePush(d)).toBe("disabled");
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(unsubscribeApi).toHaveBeenCalledWith(
      await endpointId("https://fcm.googleapis.com/fcm/send/AbC"),
    );
  });
  it("still counts as disabled when the server call fails", async () => {
    const sub = {
      toJSON: () => ({ endpoint: "https://fcm.googleapis.com/x" }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const { deps: d } = setup(sub, vi.fn().mockRejectedValue(new Error("x")));
    expect(await disablePush(d)).toBe("disabled");
  });
  it("reports no subscription, and never throws", async () => {
    expect(await disablePush(setup(null).deps)).toBe("not-subscribed");
    expect(
      await disablePush({
        registration: vi.fn().mockRejectedValue(new Error("x")),
        api: {} as never,
      }),
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
