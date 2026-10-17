/**
 * Developer API keys minted by the Nyuchi API gateway (nyuchi/api-gateway
 * #298/#312/#307): list + create.
 *
 *   GET  /api/app-keys → the signed-in person's weather keys (masked)
 *   POST /api/app-keys → mint one; the full key is in this answer only
 *
 * Signed-in only (`withAuth()`, 401 otherwise). Each request exchanges the
 * person's own WorkOS access token for a short-lived platform person token
 * (`gateway-person-token.ts`) and calls `/v1/app-keys` with it — never a
 * shared token. Runs alongside the legacy `/api/keys` (`mk_live_` keys
 * written straight to `platform.apiKeys`), which is unchanged.
 */

import { NextRequest, NextResponse } from "next/server";
import { appKeys } from "@/lib/gateway-app-keys";
import { sanitizeLabel } from "@/lib/api-keys";
import {
  errorResponse,
  NO_STORE,
  rejectCrossSite,
  withPersonToken,
} from "./shared";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return withPersonToken("list", async (personToken) => {
    const keys = await appKeys.list(personToken);
    return NextResponse.json({ keys }, { headers: NO_STORE });
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const raw =
    body && typeof body === "object" && "label" in body
      ? (body as { label?: unknown }).label
      : "";
  const label = sanitizeLabel(raw);
  // Validated before the sign-in gate, the rate limit and the exchange, so a
  // malformed request costs nothing.
  if (!label) return errorResponse(400, "invalid_label");
  return withPersonToken("create", async (personToken) => {
    const key = await appKeys.create(personToken, label);
    return NextResponse.json({ key }, { status: 201, headers: NO_STORE });
  });
}
