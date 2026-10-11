/**
 * Service-worker side of web push, as pure functions (mukoko-dev/mukoko-weather#289).
 *
 * No Serwist, no Next, no `self`: the toolchain-specific file (src/app/sw.ts
 * today) only wires these into `push` and `notificationclick`. Delivery is
 * best effort, so nothing here assumes a push will arrive.
 */

import { urlBase64ToUint8Array } from "./client";

export interface PushPayload {
  v: 1;
  kind: string;
  slug: string;
  night: string;
  title: string;
  body: string;
  url: string;
}

export interface ShownNotification {
  title: string;
  options: {
    body: string;
    tag: string;
    data: { url: string };
    icon: string;
    badge: string;
  };
}

export const FALLBACK: ShownNotification = {
  title: "mukoko weather",
  options: {
    body: "There is a weather update for a place you follow.",
    tag: "weather-update",
    data: { url: "/" },
    icon: "/icon-192.png",
    // TODO: the badge should be a monochrome glyph (Android masks it to its
    // alpha channel, so a full-colour icon shows as a grey square). Needs a
    // designed asset; out of scope here.
    badge: "/icon-192.png",
  },
};

/** Never a real origin: only used to tell a same-origin target from another. */
const PROBE_ORIGIN = "https://same-origin.invalid";
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Same-origin path only: a push must never open another site. The target is
 * resolved the way a browser would and kept only if it stays on the origin, so
 * tricks the URL parser normalises (`/\\evil`, `\t//evil`, `javascript:`) are
 * caught by the same check. Control characters are rejected up front: the URL
 * parser silently strips tab and newline, which would turn `/\t/evil` into
 * `//evil`.
 */
export function safeTarget(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300)
    return "/";
  if (CONTROL_CHARS.test(raw) || raw.includes("\\")) return "/";
  let u: URL;
  try {
    u = new URL(raw, PROBE_ORIGIN);
  } catch {
    return "/";
  }
  if (u.origin !== PROBE_ORIGIN) return "/";
  const out = u.pathname + u.search + u.hash;
  return out.startsWith("//") ? "/" : out;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

/**
 * Turn the raw push data into a notification. A browser must show something
 * for every push (userVisibleOnly), so a missing or malformed payload falls
 * back to a generic message rather than throwing.
 */
export function notificationFor(raw: unknown): ShownNotification {
  let data: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object")
        data = parsed as Record<string, unknown>;
    } catch {
      data = null;
    }
  } else if (raw && typeof raw === "object") {
    data = raw as Record<string, unknown>;
  }
  if (!data || data.v !== 1) return FALLBACK;
  const title = str(data.title, 120);
  const body = str(data.body, 300);
  if (!title || !body) return FALLBACK;
  const kind = str(data.kind, 20) ?? "alert";
  const slug = str(data.slug, 80) ?? "";
  const night = str(data.night, 10) ?? "";
  return {
    title,
    options: {
      body,
      // One notification per place, kind and night: a repeat replaces it.
      tag: `${kind}:${slug}:${night}`,
      data: { url: safeTarget(data.url) },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    },
  };
}

export interface WindowLike {
  url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * What a notification click should do: focus an open window of this origin
 * (navigating it to the target) or open a new one.
 */
export function clickAction(
  data: unknown,
  windows: readonly WindowLike[],
  origin: string,
):
  | { kind: "focus"; window: WindowLike; url: string }
  | { kind: "open"; url: string } {
  const target = safeTarget(
    (data as { url?: unknown } | null | undefined)?.url,
  );
  const absolute = new URL(target, origin).href;
  const existing = windows.find((w) => sameOrigin(w.url, origin));
  return existing
    ? { kind: "focus", window: existing, url: absolute }
    : { kind: "open", url: absolute };
}

export interface ClientsLike {
  matchAll(o: {
    type: "window";
    includeUncontrolled: boolean;
  }): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * Handle a notification click: prefer a window this worker controls, then any
 * window of the origin; focus it first (it needs the click's user activation),
 * then navigate. If anything rejects, open a new window instead so the click
 * is never a no-op.
 */
export async function openFromClick(
  data: unknown,
  clients: ClientsLike,
  origin: string,
): Promise<void> {
  try {
    let action = clickAction(
      data,
      await clients.matchAll({ type: "window", includeUncontrolled: false }),
      origin,
    );
    if (action.kind === "open")
      action = clickAction(
        data,
        await clients.matchAll({ type: "window", includeUncontrolled: true }),
        origin,
      );
    if (action.kind === "focus") {
      await action.window.focus();
      if (action.window.navigate) await action.window.navigate(action.url);
      return;
    }
    await clients.openWindow(action.url);
  } catch {
    await clients.openWindow(clickAction(data, [], origin).url);
  }
}

/**
 * A browser must show something for every push (userVisibleOnly). If showing
 * the real notification fails, show the generic one rather than none.
 */
export async function showWithFallback(
  registration: {
    showNotification(title: string, options: object): Promise<void>;
  },
  n: ShownNotification,
): Promise<void> {
  try {
    await registration.showNotification(n.title, n.options);
  } catch {
    await registration.showNotification(FALLBACK.title, FALLBACK.options);
  }
}

/**
 * `pushsubscriptionchange`: the browser rotated or dropped the subscription.
 * Subscribe again with the current VAPID key and register the new one.
 * Best effort; never throws.
 */
export async function resubscribeAfterChange(deps: {
  registration: {
    pushManager: {
      subscribe(o: {
        userVisibleOnly: true;
        applicationServerKey: Uint8Array;
      }): Promise<{ toJSON(): unknown }>;
    };
  };
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  base?: string;
}): Promise<boolean> {
  const base = deps.base ?? "/api/push";
  try {
    const cfg = await deps.fetchFn(`${base}/config`, {
      credentials: "same-origin",
    });
    if (!cfg.ok) return false;
    const { vapid_public_key } = (await cfg.json()) as {
      vapid_public_key: string;
    };
    const sub = await deps.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid_public_key),
    });
    const json = sub.toJSON() as { endpoint?: string; keys?: unknown };
    const res = await deps.fetchFn(`${base}/subscriptions`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
