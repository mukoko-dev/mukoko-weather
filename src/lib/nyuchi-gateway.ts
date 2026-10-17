/**
 * Server-only access to the Nyuchi API gateway (`api.nyuchi.com`) for the
 * per-person flows (nyuchi/api-gateway#307): the RFC 8693 person-token
 * exchange and `/v1/app-keys`.
 *
 * **Transport is an interface.** The Next.js server on Vercel reaches the
 * gateway with `fetch` against `NYUCHI_API_URL` (`fetchTransport`). A weather
 * Worker would instead pass its Cloudflare service binding
 * (`serviceBindingTransport(env.NYUCHI_API)`), which has the same
 * `(Request) => Promise<Response>` shape. A binding is transport only: it
 * says nothing about who the user is, so every per-person call still carries
 * the person's own exchanged token.
 *
 * **Credential.** `NYUCHI_APP_KEYS_API_KEY` is this app's own internal key,
 * `nyk_<id>.nys_<secret>`, scoped `identity app-keys weather` and nothing
 * else (`identity` because the exchange requires it, `weather` because
 * `/v1/app-keys` binds a backend to exactly one app namespace). It is a
 * dedicated key: the Workers' `NYUCHI_API_KEY` (places, guardrails) must
 * never gain `identity`. Server-only, never `NEXT_PUBLIC_*`, never logged.
 * There is deliberately no shared service token that can act for a person.
 */

/** One request to the gateway; the path is absolute (`/v1/...`). */
export type GatewayTransport = (request: Request) => Promise<Response>;

/** The gateway's key pair, split from `nyk_<id>.nys_<secret>`. */
export interface GatewayCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GatewayConfig {
  transport: GatewayTransport;
  credentials: GatewayCredentials;
}

/** Placeholder origin for a service binding (the host is ignored). */
const BINDING_ORIGIN = "https://nyuchi-api.internal";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const KEY_RE = /^(nyk_[A-Za-z0-9_-]{8,128})\.(nys_[A-Za-z0-9_-]{8,256})$/;
export const GATEWAY_TIMEOUT_MS = 8_000;

type Env = Record<string, string | undefined>;

function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error("nyuchi-gateway is server-only");
  }
}

/** A bare https origin (http only for localhost), else null. */
export function gatewayOrigin(env: Env = process.env): string | null {
  const raw = env.NYUCHI_API_URL?.trim();
  if (!raw) return null;
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

/** The key pair, or null when unset or malformed (never echoed). */
export function gatewayCredentials(
  env: Env = process.env,
): GatewayCredentials | null {
  const match = KEY_RE.exec(env.NYUCHI_APP_KEYS_API_KEY?.trim() ?? "");
  return match ? { clientId: match[1], clientSecret: match[2] } : null;
}

/** Largest gateway answer read into memory (token and key JSON are tiny). */
export const MAX_GATEWAY_BODY_BYTES = 256 * 1024;
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * `fetch` to `origin`: no redirects followed, no caching, and one timeout
 * that covers the whole exchange, headers AND body (the body is read inside
 * it and handed back buffered, at most `MAX_GATEWAY_BODY_BYTES`).
 */
export function fetchTransport(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
): GatewayTransport {
  return async (request) => {
    const source = new URL(request.url);
    const target = new URL(source.pathname + source.search, origin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    try {
      const response = await fetchImpl(target, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? await request.text() : undefined,
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
      if (NULL_BODY_STATUS.has(response.status)) {
        return new Response(null, {
          status: response.status,
          headers: response.headers,
        });
      }
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_GATEWAY_BODY_BYTES) {
        throw new Error("gateway answer too large");
      }
      const body = await response.arrayBuffer();
      if (body.byteLength > MAX_GATEWAY_BODY_BYTES) {
        throw new Error("gateway answer too large");
      }
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Minimal shape of a Cloudflare service binding (`Fetcher`). */
export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/** The same interface over a Cloudflare service binding (Workers). */
export function serviceBindingTransport(
  binding: ServiceBinding,
): GatewayTransport {
  return (request) => binding.fetch(request);
}

/** Build a gateway request; the origin is replaced by the transport. */
export function gatewayRequest(path: string, init: RequestInit): Request {
  return new Request(new URL(path, BINDING_ORIGIN), init);
}

/** The configured gateway, or null when anything is missing (fail closed). */
export function gatewayConfig(env: Env = process.env): GatewayConfig | null {
  assertServer();
  const origin = gatewayOrigin(env);
  const credentials = gatewayCredentials(env);
  if (!origin || !credentials) return null;
  return { transport: fetchTransport(origin), credentials };
}

/** A `Retry-After` in whole seconds, 1–3600; anything else is ignored. */
export function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw || !/^\d{1,10}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n > 0 ? Math.min(n, 3600) : undefined;
}

/** Read the gateway's `{detail: {error, error_description}}` code, safely. */
export async function gatewayErrorCode(
  response: Response,
): Promise<string | null> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const detail =
      body && typeof body.detail === "object" && body.detail
        ? (body.detail as Record<string, unknown>)
        : body;
    const code = detail?.error;
    return typeof code === "string" && /^[a-z_]{1,48}$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}
