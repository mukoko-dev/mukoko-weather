/**
 * The signed-in person's devices (mukoko-dev/mukoko-weather#320).
 *
 *   GET  /api/devices → where this person is signed in (their own WorkOS
 *                       sessions: label, last active, "this device"; never an
 *                       IP address or a raw user agent)
 *   POST /api/devices → register or refresh this device (permissions and
 *                       preferences) on the platform device record
 *
 * GET works today. POST is written against the platform contract in
 * `platform-devices.ts` and answers 503 `devices_unavailable` until the
 * Nyuchi API serves it; the client then keeps everything on the device.
 */

import { NextRequest, NextResponse } from "next/server";
import { listSignedInDevices, workosSessionsApi } from "@/lib/device-sessions";
import {
  createPlatformDevicesClient,
  DevicesError,
  NYUCHI_API_ORIGIN,
  PLATFORM_DEVICES_READY,
  registerWithPlatform,
  sanitizeRegistration,
} from "@/lib/platform-devices";
import { fetchTransport } from "@/lib/nyuchi-gateway";
import { logWarn } from "@/lib/observability";
import { errorResponse, NO_STORE, rejectCrossSite, withCaller } from "./shared";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return withCaller("list", async ({ userId, sessionId }) => {
    try {
      const devices = await listSignedInDevices(
        await workosSessionsApi(),
        userId,
        sessionId,
      );
      return NextResponse.json(
        { devices, source: "workos-session" },
        { headers: NO_STORE },
      );
    } catch {
      // Ids only: WorkOS errors can echo request material.
      logWarn({
        source: "unhandled",
        message: "Could not list WorkOS sessions for /api/devices",
      });
      return errorResponse(503, "sessions_unavailable");
    }
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  // Validated before the sign-in gate, the limit and anything else.
  const registration = sanitizeRegistration(body);
  if (!registration) return errorResponse(400, "invalid_request");

  return withCaller("register", async ({ sessionId }) => {
    try {
      await registerWithPlatform(registration, sessionId, {
        ready: PLATFORM_DEVICES_READY,
        token: async () => {
          // No devices-scoped person token can be minted yet (ask 5 of #320).
          throw new DevicesError(503, "devices_unavailable");
        },
        client: createPlatformDevicesClient(() =>
          fetchTransport(NYUCHI_API_ORIGIN),
        ),
      });
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    } catch (err) {
      if (err instanceof DevicesError) {
        return errorResponse(err.status, err.code, err.retryAfterSeconds);
      }
      return errorResponse(503, "devices_unavailable");
    }
  });
}
