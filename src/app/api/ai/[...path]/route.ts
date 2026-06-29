/**
 * Auth-gated proxy for the Python AI endpoints.
 *
 * The Python FastAPI app cannot decode the WorkOS AuthKit session cookie
 * directly (the cookie is encrypted with WORKOS_COOKIE_PASSWORD on the
 * Next.js side). This route is the bridge: every AI request first lands
 * here, we validate the session with `withAuth()`, then forward to
 * `/api/py/ai/${path}` with the user identity attached as headers so the
 * Python layer can log/audit per-user without re-validating.
 *
 * Why proxy instead of gating in Python:
 *   - Single source of truth for auth (AuthKit)
 *   - Python doesn't need WorkOS SDK or cookie crypto
 *   - 401 lands fast (no round-trip into FastAPI for unauth users)
 *
 * All HTTP methods are passed through. Query string + body are preserved.
 * Hop-by-hop headers are stripped.
 */

import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";

export const dynamic = "force-dynamic";

/** Headers we never forward upstream (hop-by-hop, host-specific, or auth). */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "cookie",
  "content-length",
]);

/** Response headers we drop on the way back to the client. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

interface ProxyParams {
  params: Promise<{ path: string[] }>;
}

async function proxy(req: NextRequest, { params }: ProxyParams): Promise<Response> {
  const { user } = await withAuth();
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in to use Mukoko AI features." },
      { status: 401 },
    );
  }

  const { path } = await params;
  const subpath = (path ?? []).join("/");
  const url = new URL(req.url);
  // Build the upstream URL — same origin, but rerouted to the Python prefix.
  const upstream = new URL(`/api/py/ai/${subpath}`, url.origin);
  upstream.search = url.search;

  // Forward request headers minus hop-by-hop / cookie, plus the user identity.
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  headers.set("X-Mukoko-User-Id", user.id);
  if (user.email) headers.set("X-Mukoko-User-Email", user.email);

  // Body is only meaningful for non-GET/HEAD. NextRequest exposes a stream
  // body — pass it through verbatim. `duplex: "half"` is required by the
  // Fetch spec when streaming a request body in Node 18+/undici.
  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const upstreamRes = await fetch(upstream, {
    method,
    headers,
    body: hasBody ? req.body : undefined,
    // @ts-expect-error — `duplex` is required for streaming bodies in undici
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
  });

  // Mirror response headers (minus hop-by-hop) back to the client.
  const responseHeaders = new Headers();
  upstreamRes.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
