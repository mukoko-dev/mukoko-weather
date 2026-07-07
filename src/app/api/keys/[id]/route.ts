/**
 * Developer API key revocation.
 *
 *   DELETE /api/keys/:id → revoke (soft-delete) one of the caller's own keys.
 *
 * Gated by `withAuth()`. The revoke is scoped to `(_id, ownerPersonId,
 * surfaceContext, keyType)` so a user can only ever revoke a key they own —
 * passing someone else's id (or an already-revoked one) matches nothing and
 * returns 404. Revocation is a soft-delete (`isActive: false` + `revokedAt`),
 * never a hard delete.
 */

import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { WorkOSUser } from "@/lib/auth";
import { resolveOwnerPersonId, revokeDeveloperApiKey } from "@/lib/api-keys";

export const dynamic = "force-dynamic";

/** UUID-ish id guard — rejects unexpected input before touching the DB. */
const ID_RE = /^[a-f0-9-]{8,64}$/i;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in to manage API keys." },
      { status: 401 },
    );
  }

  const { id } = await params;
  if (!id || !ID_RE.test(id)) {
    return NextResponse.json(
      { error: "invalid_id", message: "Invalid key id." },
      { status: 400 },
    );
  }

  const personId = await resolveOwnerPersonId(user as WorkOSUser);
  const revoked = await revokeDeveloperApiKey(personId, id);
  if (!revoked) {
    return NextResponse.json(
      { error: "not_found", message: "Key not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({ revoked: true });
}
