/**
 * Page-side web push: support detection, the permission/subscribe flow and
 * the Nyuchi API client (mukoko-dev/mukoko-weather#289). Framework-agnostic:
 * everything the browser provides is injected, so it tests in node.
 *
 * Ask for permission only from a user gesture, after explaining the benefit.
 * iOS delivers web push only to a web app added to the Home Screen (16.4+).
 */

export type PushState =
  | "unsupported" // no service worker / Push API / Notification
  | "needs-install" // iOS Safari tab: install to the Home Screen first
  | "denied" // the browser blocks notifications for this site
  | "available" // can ask (permission "default")
  | "granted"; // permission granted (may or may not be subscribed)

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: "default" | "granted" | "denied" | undefined;
  isIos: boolean;
  isStandalone: boolean;
}

export function pushState(env: PushEnv): PushState {
  if (env.isIos && !env.isStandalone) return "needs-install";
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification)
    return "unsupported";
  if (env.permission === "denied") return "denied";
  if (env.permission === "granted") return "granted";
  return "available";
}

export function detectEnv(w: Window & typeof globalThis = window): PushEnv {
  const ua = w.navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (w.navigator.platform === "MacIntel" && w.navigator.maxTouchPoints > 1);
  const standalone =
    (w.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    w.matchMedia?.("(display-mode: standalone)").matches === true;
  return {
    hasServiceWorker: "serviceWorker" in w.navigator,
    hasPushManager: "PushManager" in w,
    hasNotification: "Notification" in w,
    permission: "Notification" in w ? w.Notification.permission : undefined,
    isIos,
    isStandalone: standalone,
  };
}

/** VAPID public keys travel as unpadded base64url. */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export interface AlertPreferences {
  frost: boolean;
  quiet_start: number;
  quiet_end: number;
  place_slugs: string[];
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A thin client for the app's push routes (which forward to the Nyuchi API). */
export function pushApi(
  base = "/api/push",
  fetchFn: Fetch = (i, o) => fetch(i, o),
) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchFn(`${base}${path}`, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!res.ok) throw new Error(`push_api_${res.status}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  return {
    config: () => call<{ vapid_public_key: string }>("/config"),
    subscribe: (sub: PushSubscriptionJSON, platform?: string) =>
      call<{ id: string }>("/subscriptions", {
        method: "PUT",
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: sub.keys,
          platform,
        }),
      }),
    unsubscribe: (id: string) =>
      call<void>(`/subscriptions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    getPreferences: () => call<AlertPreferences>("/alert-preferences"),
    setPreferences: (p: AlertPreferences) =>
      call<AlertPreferences>("/alert-preferences", {
        method: "PUT",
        body: JSON.stringify(p),
      }),
  };
}

export interface RegistrationLike {
  pushManager: {
    getSubscription(): Promise<{
      toJSON(): PushSubscriptionJSON;
      unsubscribe(): Promise<boolean>;
    } | null>;
    subscribe(o: {
      userVisibleOnly: true;
      applicationServerKey: Uint8Array;
    }): Promise<{
      toJSON(): PushSubscriptionJSON;
    }>;
  };
}

export type EnableResult = "enabled" | "denied" | "unsupported" | "error";

/**
 * Call from a click handler. Requests permission, subscribes and registers
 * the subscription with the server. Never throws.
 */
export async function enablePush(deps: {
  env: PushEnv;
  requestPermission: () => Promise<"default" | "granted" | "denied">;
  registration: () => Promise<RegistrationLike>;
  api: ReturnType<typeof pushApi>;
  platform?: string;
}): Promise<EnableResult> {
  const state = pushState(deps.env);
  if (state === "unsupported" || state === "needs-install")
    return "unsupported";
  if (state === "denied") return "denied";
  try {
    if (state === "available") {
      const p = await deps.requestPermission();
      if (p !== "granted") return p === "denied" ? "denied" : "error";
    }
    const [{ vapid_public_key }, reg] = await Promise.all([
      deps.api.config(),
      deps.registration(),
    ]);
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid_public_key),
      }));
    await deps.api.subscribe(sub.toJSON(), deps.platform);
    return "enabled";
  } catch {
    return "error";
  }
}
