/**
 * "A bare origin": the one rule for an API host the app is told about, shared
 * by the server (`nyuchi-gateway.ts` reading `NYUCHI_API_URL`) and the browser
 * (`rxdb/couch-session.ts` reading the `apiOrigin` the session route hands the
 * page). It is dependency free on purpose, so the browser bundle that imports
 * it takes nothing server-only with it, and so the two ends cannot drift: what
 * the server accepts is exactly what the page will accept.
 *
 * An https origin (http only for localhost, for development) with no
 * credentials, path, query or fragment. Anything else is `null`: a value that
 * is not an origin is never "fixed up" into one.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin (`https://host[:port]`, no trailing slash) of `raw`, else null. */
export function parseBareOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}
