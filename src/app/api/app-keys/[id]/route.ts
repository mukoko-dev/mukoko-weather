/**
 * DELETE /api/app-keys/:id — revoke one of the signed-in person's
 * gateway-minted weather keys. The gateway scopes revocation to the person
 * whose token the call carries; another person's id is a 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { appKeys, APP_KEY_ID_RE } from "@/lib/gateway-app-keys";
import { errorResponse, NO_STORE, withPersonToken } from "../shared";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id } = await params;
  return withPersonToken(async (personToken) => {
    if (!id || !APP_KEY_ID_RE.test(id)) return errorResponse(400, "invalid_id");
    await appKeys.revoke(personToken, id);
    return NextResponse.json({ revoked: true }, { headers: NO_STORE });
  });
}
