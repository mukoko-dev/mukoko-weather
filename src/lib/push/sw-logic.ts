/**
 * Service-worker side of web push, as pure functions (mukoko-dev/mukoko-weather#289).
 *
 * No Serwist, no Next, no `self`: the toolchain-specific file (src/app/sw.ts
 * today) only wires these into `push` and `notificationclick`. Delivery is
 * best effort, so nothing here assumes a push will arrive.
 */

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

const FALLBACK: ShownNotification = {
  title: "mukoko weather",
  options: {
    body: "There is a weather update for a place you follow.",
    tag: "weather-update",
    data: { url: "/" },
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  },
};

/** Same-origin path only: a push must never open another site. */
export function safeTarget(url: unknown): string {
  if (typeof url !== "string" || url.length === 0 || url.length > 300)
    return "/";
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\"))
    return "/";
  return url;
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
  const existing = windows.find((w) => w.url.startsWith(origin));
  return existing
    ? { kind: "focus", window: existing, url: absolute }
    : { kind: "open", url: absolute };
}
