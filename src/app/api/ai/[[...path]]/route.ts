/**
 * Auth-gated proxy for the AI routes.
 *
 * The browser calls `/api/ai/*`. This route is the sign-in gate: it validates
 * the WorkOS AuthKit session with `withAuth()` (the cookie is encrypted with
 * WORKOS_COOKIE_PASSWORD on this side, so nothing downstream could read it)
 * and answers 401 to anonymous callers. A signed-in call is then sent to the
 * backend with who is asking:
 *
 * - the weather summary (the bare `/api/ai`) goes to the internal weather
 *   Worker (`src/lib/ai-worker.ts`: `WEATHER_SERVICE_URL`, the service key
 *   `WEATHER_SERVICE_API_KEY`), which runs it on Workers AI and counts it
 *   against the person's hour;
 * - the rest (`followup`, `agriculture`) still go to the Python functions
 *   (`/api/py/ai/*`) until they are ported (#333).
 *
 * Why a proxy at all: AuthKit is the single source of truth for who is signed
 * in. The backend gets a clean request with a user id and never the session
 * cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import {
  AI_WORKER_TIMEOUT_MS,
  MAX_AI_BODY_BYTES,
  aiWorkerHeaders,
  aiWorkerOrigin,
  aiWorkerPath,
  visitorIp,
} from "@/lib/ai-worker";

export const dynamic = "force-dynamic";

/** Headers we never forward to the Python functions (hop-by-hop, host-specific, or auth). */
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
  // Optional catch-all — `path` is undefined for the bare /api/ai request.
  params: Promise<{ path?: string[] }>;
}

/** A small JSON error in the Workers' envelope. */
function problem(status: number, error: string, description: string) {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Send a signed-in call to the internal weather Worker and hand its answer
 * back (status, JSON, `Retry-After`). Nothing from the visitor's request but
 * the body crosses; the service key never leaves the server.
 */
async function viaWorker(
  req: NextRequest,
  workerPath: string,
  userId: string,
): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") {
    return problem(405, "method_not_allowed", "Only POST is served.");
  }
  const origin = aiWorkerOrigin();
  const key = (process.env.WEATHER_SERVICE_API_KEY ?? "").trim();
  if (!origin || !key) {
    return problem(
      503,
      "ai_unavailable",
      "Shamwari is not available right now. Please try again later.",
    );
  }
  const body = await req.text();
  if (new TextEncoder().encode(body).length > MAX_AI_BODY_BYTES) {
    return problem(413, "payload_too_large", "The request body is too large.");
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${origin}${workerPath}`, {
      method: "POST",
      headers: aiWorkerHeaders({
        key,
        userId,
        ip: visitorIp(req.headers),
      }),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(AI_WORKER_TIMEOUT_MS),
    });
  } catch {
    return problem(502, "upstream_unreachable", "Shamwari did not answer.");
  }
  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-store",
  });
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** The Python functions (until followup and agriculture are ported). */
async function viaPython(
  req: NextRequest,
  subpath: string,
  userId: string,
  userEmail: string | null,
): Promise<Response> {
  const url = new URL(req.url);
  const upstream = new URL(`/api/py/ai/${subpath}`, url.origin);
  upstream.search = url.search;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  headers.set("X-Mukoko-User-Id", userId);
  if (userEmail) headers.set("X-Mukoko-User-Email", userEmail);
  // Shared-secret stamp (issue #92): when MUKOKO_INTERNAL_SECRET is set —
  // one env var read by both the Next.js and Python runtimes of the same
  // deployment — Python's require_internal_caller() rejects any /api/py/ai/*
  // request that didn't come through this proxy. Unset = guard disabled.
  const internalSecret = process.env.MUKOKO_INTERNAL_SECRET;
  if (internalSecret) headers.set("X-Mukoko-Internal", internalSecret);

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

async function proxy(
  req: NextRequest,
  { params }: ProxyParams,
): Promise<Response> {
  const { user } = await withAuth();
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in to use Mukoko AI features." },
      { status: 401 },
    );
  }

  const { path } = await params;
  const subpath = (path ?? []).join("/");
  const workerPath = aiWorkerPath(subpath);
  if (workerPath !== undefined) return viaWorker(req, workerPath, user.id);
  return viaPython(req, subpath, user.id, user.email ?? null);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
