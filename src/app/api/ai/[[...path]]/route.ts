/**
 * Auth-gated proxy for the AI routes.
 *
 * The browser calls `/api/ai/*`. This route is the sign-in gate: it validates
 * the WorkOS AuthKit session with `withAuth()` (the cookie is encrypted with
 * WORKOS_COOKIE_PASSWORD on this side, so nothing downstream could read it)
 * and answers 401 to anonymous callers. A signed-in call is then sent to the
 * internal weather Worker (`src/lib/ai-worker.ts`: `WEATHER_SERVICE_URL`, the
 * service key `WEATHER_SERVICE_API_KEY`) with who is asking:
 *
 * - the bare `/api/ai`: the weather summary;
 * - `/api/ai/followup`: the follow-up chat on a location page;
 * - `/api/ai/agriculture`: the agriculture explanation (`snapshot` or
 *   `briefing`).
 *
 * The Worker runs them on Workers AI and counts each model call against the
 * person's hour. Any other subpath is a 404: nothing is forwarded blindly.
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
  if (workerPath === undefined) {
    return problem(404, "not_found", "No such AI route.");
  }
  return viaWorker(req, workerPath, user.id);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
