/**
 * DELETE /api/devices/{id} — sign one of the caller's other devices out.
 *
 * `{id}` is a WorkOS session id from the GET listing. It is only ended if it
 * is in the caller's own active session list (`signOutDevice`), so a guessed
 * or someone else's id is "not found" and never reaches WorkOS. The current
 * device signs out through `/auth/signout`, not here.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  isSessionId,
  signOutDevice,
  workosSessionsApi,
} from "@/lib/device-sessions";
import { logWarn } from "@/lib/observability";
import {
  errorResponse,
  NO_STORE,
  rejectCrossSite,
  withCaller,
} from "../shared";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const { id } = await context.params;
  // Validated before the sign-in gate, the limit and WorkOS.
  if (!isSessionId(id)) return errorResponse(400, "invalid_id");

  return withCaller("signout", async ({ userId, sessionId }) => {
    if (id === sessionId) return errorResponse(409, "current_device");
    try {
      const result = await signOutDevice(await workosSessionsApi(), userId, id);
      if (result === "not_found") return errorResponse(404, "device_not_found");
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    } catch {
      logWarn({
        source: "unhandled",
        message: "Could not end a WorkOS session for /api/devices",
      });
      return errorResponse(503, "sessions_unavailable");
    }
  });
}
