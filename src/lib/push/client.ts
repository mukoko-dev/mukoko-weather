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
  b64 = b64.replace(/=+$/, "");
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
    /** `id` is the server's subscription id (the endpoint hash). */
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

export interface SubscriptionLike {
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
  options?: { applicationServerKey: ArrayBuffer | null };
}

export interface RegistrationLike {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(o: {
      userVisibleOnly: true;
      applicationServerKey: Uint8Array;
    }): Promise<SubscriptionLike>;
  };
}

export type EnableResult =
  | "enabled"
  | "denied" // the browser blocks notifications for this site
  | "dismissed" // the prompt was closed without a choice; may ask again later
  | "needs-install" // iOS Safari tab: add to the Home Screen first
  | "unsupported"
  | "error";

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/**
 * Call from a click handler. Requests permission, subscribes and registers
 * the subscription with the server. An existing subscription made with a
 * different VAPID key is replaced (it could never be pushed to). Never throws.
 */
export async function enablePush(deps: {
  env: PushEnv;
  requestPermission: () => Promise<"default" | "granted" | "denied">;
  registration: () => Promise<RegistrationLike>;
  api: ReturnType<typeof pushApi>;
  platform?: string;
}): Promise<EnableResult> {
  const state = pushState(deps.env);
  if (state === "needs-install") return "needs-install";
  if (state === "unsupported") return "unsupported";
  if (state === "denied") return "denied";
  try {
    if (state === "available") {
      const p = await deps.requestPermission();
      if (p === "denied") return "denied";
      if (p !== "granted") return "dismissed";
    }
    const [{ vapid_public_key }, reg] = await Promise.all([
      deps.api.config(),
      deps.registration(),
    ]);
    const key = urlBase64ToUint8Array(vapid_public_key);
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with another VAPID key is dead weight: the push
    // service rejects our sends with 403. Replace it. If the browser does not
    // expose the key, keep the subscription.
    if (
      sub?.options &&
      sub.options.applicationServerKey &&
      !sameKey(sub.options.applicationServerKey, key)
    ) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    await deps.api.subscribe(sub.toJSON(), deps.platform);
    return "enabled";
  } catch {
    return "error";
  }
}

/** The server's subscription id for an endpoint: SHA-256, hex (as the API). */
export async function endpointId(endpoint: string): Promise<string> {
  // Canonical form, matching weather-core's `endpoint_id`: lower-case host,
  // default port dropped.
  const m = /^https:\/\/([^/?#]*)([\s\S]*)$/.exec(endpoint);
  const canonical = m
    ? `https://${m[1].replace(/:443$/, "").toLowerCase()}${m[2]}`
    : endpoint;
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(d), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Turn push off for this browser: unsubscribe locally, then tell the server
 * (DELETE) so it stops trying. The local unsubscribe happens first and counts
 * even if the server call fails. Never throws.
 */
export async function disablePush(deps: {
  registration: () => Promise<RegistrationLike>;
  api: ReturnType<typeof pushApi>;
}): Promise<"disabled" | "not-subscribed" | "error"> {
  try {
    const reg = await deps.registration();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return "not-subscribed";
    const endpoint = sub.toJSON().endpoint;
    await sub.unsubscribe();
    if (endpoint) {
      try {
        await deps.api.unsubscribe(await endpointId(endpoint));
      } catch {
        // The server drops a dead endpoint on its next send (404/410).
      }
    }
    return "disabled";
  } catch {
    return "error";
  }
}
