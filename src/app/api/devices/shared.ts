/**
 * Shared plumbing for /api/devices: the sign-in gate, the per-user rate
 * limit and one error shape. The user id and the current session id come only
 * from the AuthKit session, never from the request. The CSRF guard is the
 * one /api/app-keys uses (same origin + `application/json`).
 */

import { NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { checkUserRateLimit } from "@/lib/user-rate-limit";

export { rejectCrossSite } from "@/app/api/app-keys/shared";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export type DevicesAction = "list" | "register" | "signout";

/** Per user: [max requests, window seconds]. */
export const DEVICES_LIMITS: Record<DevicesAction, [number, number]> = {
  list: [30, 60],
  register: [20, 3600],
  signout: [20, 3600],
};

const MESSAGES: Record<string, string> = {
  unauthorized: "Sign in to see your devices.",
  rate_limited: "Too many requests. Try again shortly.",
  devices_unavailable:
    "Saving this device to your account is not available yet. It still works on this device.",
  sessions_unavailable:
    "Your devices are temporarily unavailable. Try again shortly.",
  invalid_request: "The request was not accepted.",
  invalid_id: "Invalid device id.",
  device_not_found: "That device is no longer signed in.",
  current_device: "Use Sign out to sign this device out.",
};

export function errorResponse(
  status: number,
  error: string,
  retryAfterSeconds?: number,
): NextResponse {
  const headers: Record<string, string> = { ...NO_STORE };
  if (retryAfterSeconds) headers["Retry-After"] = String(retryAfterSeconds);
  return NextResponse.json(
    { error, message: MESSAGES[error] ?? MESSAGES.sessions_unavailable },
    { status, headers },
  );
}

export interface CallerSession {
  userId: string;
  sessionId: string | undefined;
}

/** The signed-in caller, or null (anonymous, or a path AuthKit skipped). */
export async function currentCaller(): Promise<CallerSession | null> {
  try {
    const { user, sessionId } = await withAuth();
    return user?.id ? { userId: user.id, sessionId } : null;
  } catch {
    return null;
  }
}

/** 401 when anonymous, 429 over the per-user limit, else run `fn`. */
export async function withCaller(
  action: DevicesAction,
  fn: (caller: CallerSession) => Promise<NextResponse>,
): Promise<NextResponse> {
  const caller = await currentCaller();
  if (!caller) return errorResponse(401, "unauthorized");
  const [max, window] = DEVICES_LIMITS[action];
  const limit = await checkUserRateLimit(
    `devices-${action}`,
    caller.userId,
    max,
    window,
  );
  if (!limit.allowed) {
    return errorResponse(429, "rate_limited", limit.retryAfterSeconds);
  }
  return fn(caller);
}
