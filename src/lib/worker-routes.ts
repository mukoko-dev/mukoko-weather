/**
 * The per-route cutover from the Python backend (`/api/py/*`) to the Rust
 * Workers (mukoko-weather#148). Dormant by default: with
 * `NEXT_PUBLIC_WEATHER_API_BASE` or `NEXT_PUBLIC_WEATHER_WORKER_ROUTES` unset,
 * every call stays on `/api/py/*`.
 *
 * To serve a route from the Worker, set the base (`https://weather-api.mukoko.com`)
 * and list the route (`search,geo`). To roll it back, unset or shorten the list.
 * The browser calls the Worker directly (CORS is allowlisted there) rather than
 * through a Vercel rewrite, so the Worker sees the visitor's own address for its
 * per-IP limits instead of Vercel's egress address.
 *
 * Only routes the places Worker serves with the Python shape can be listed.
 */

/** Route names that may be served by a Worker, with their Worker path. */
export const WORKER_ROUTES = {
  search: "/v1/search",
  geo: "/v1/geo",
  locations: "/v1/locations",
} as const;

export type WorkerRouteName = keyof typeof WORKER_ROUTES;

function isRouteName(name: string): name is WorkerRouteName {
  return Object.prototype.hasOwnProperty.call(WORKER_ROUTES, name);
}

/** The routes named in a comma list; unknown names are ignored. */
export function parseWorkerRoutes(raw: string | undefined): Set<WorkerRouteName> {
  const out = new Set<WorkerRouteName>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if (isRouteName(name)) out.add(name);
  }
  return out;
}

/** A bare `https` origin (or `http://localhost` for development), else null. */
export function parseWorkerBase(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && url.hostname === "localhost";
    if (url.protocol !== "https:" && !local) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface WorkerRouteEnv {
  base?: string;
  routes?: string;
}

/**
 * The URL to call for an `/api/py/<route>[?query]` path: the Worker's when
 * that route is switched on, else the path unchanged. A path with another
 * segment (`/api/py/locations/add`, `/api/py/locations/profile`) is never
 * switched: the Worker does not serve it.
 */
export function weatherApiUrl(path: string, env?: WorkerRouteEnv): string {
  const base = parseWorkerBase(env ? env.base : process.env.NEXT_PUBLIC_WEATHER_API_BASE);
  if (!base) return path;
  const routes = parseWorkerRoutes(
    env ? env.routes : process.env.NEXT_PUBLIC_WEATHER_WORKER_ROUTES,
  );
  if (routes.size === 0) return path;
  const match = /^\/api\/py\/([a-z-]+)(\?.*)?$/.exec(path);
  if (!match) return path;
  const name = match[1];
  if (!isRouteName(name) || !routes.has(name)) return path;
  return `${base}${WORKER_ROUTES[name]}${match[2] ?? ""}`;
}
