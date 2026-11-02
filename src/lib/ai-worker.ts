/**
 * How the signed-in app reaches Shamwari Weather (the AI Worker).
 *
 * The browser calls `/api/ai/*` (`src/app/api/ai/[[...path]]/route.ts`). That
 * route checks the WorkOS AuthKit session, then calls the internal weather
 * Worker (`mukoko-weather-internal`, `WEATHER_SERVICE_URL`) with the service
 * key (`WEATHER_SERVICE_API_KEY`, server-only) and who is asking. The Worker
 * checks the key, forwards to `mukoko-weather-ai` over a service binding and
 * counts the model call against the person's hour (D1, `weather_core::budget`).
 * The browser never sees the key or the Worker's address, and the Worker's
 * `/internal/*` paths have no public route, so the sign-in gate cannot be
 * bypassed by calling the Worker.
 *
 * Pure helpers, tested without a server: the route table, the origin check,
 * the visitor's address and the headers.
 */

/** Longest request body the proxy forwards (the Worker's own cap is the same). */
export const MAX_AI_BODY_BYTES = 64 * 1024;

/** How long one model call may take end to end. */
export const AI_WORKER_TIMEOUT_MS = 25_000;

/**
 * `/api/ai/<subpath>` to the internal Worker's path. The bare `/api/ai` (no
 * subpath) is the weather summary.
 */
export const AI_WORKER_ROUTES: Readonly<Record<string, string>> = {
  "": "/internal/ai/summary",
  followup: "/internal/ai/followup",
  agriculture: "/internal/ai/agriculture",
};

/** The internal Worker's path for a subpath, or `undefined` when it has none. */
export function aiWorkerPath(subpath: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(AI_WORKER_ROUTES, subpath)
    ? AI_WORKER_ROUTES[subpath]
    : undefined;
}

/**
 * The internal Worker's origin from `WEATHER_SERVICE_URL`: a bare `https`
 * origin (plain `http` only for localhost). Anything else, including a URL
 * with credentials, a path, a query or a fragment, is refused, so a mistyped
 * variable cannot send the service key somewhere else.
 */
export function aiWorkerOrigin(
  raw: string | undefined = process.env.WEATHER_SERVICE_URL,
): string | null {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/**
 * The visitor's address as Vercel saw it. Vercel overwrites `x-forwarded-for`
 * at its edge, so the first entry is the real client (a header the visitor
 * sent is not in front of it). `null` when there is none.
 */
export function visitorIp(headers: Headers): string | null {
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim();
  const ip = first || headers.get("x-real-ip")?.trim() || "";
  return ip && ip.length <= 64 ? ip : null;
}

/**
 * The headers for the internal Worker: the service key, the person (their
 * WorkOS id, which the Worker keys the hourly budget by) and their address.
 * No cookie, no email.
 */
export function aiWorkerHeaders(opts: {
  key: string;
  userId: string;
  ip: string | null;
}): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${opts.key}`,
    "Content-Type": "application/json",
    "X-Mukoko-User-Id": opts.userId,
  });
  if (opts.ip) headers.set("X-Mukoko-Client-IP", opts.ip);
  return headers;
}
