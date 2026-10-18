/**
 * DELETE /api/app-keys/:id — revoke one of the signed-in person's
 * gateway-minted weather keys. The gateway scopes revocation to the person
 * whose token the call carries; another person's id is a 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { appKeys, APP_KEY_ID_RE } from "@/lib/gateway-app-keys";
import {
  errorResponse,
  NO_STORE,
  rejectCrossSite,
  withPersonToken,
} from "../shared";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const { id } = await params;
  // Validated before the sign-in gate, the rate limit and the exchange.
  if (!id || !APP_KEY_ID_RE.test(id)) return errorResponse(400, "invalid_id");
  return withPersonToken("revoke", async (personToken) => {
    await appKeys.revoke(personToken, id);
    return NextResponse.json({ revoked: true }, { headers: NO_STORE });
  });
}
