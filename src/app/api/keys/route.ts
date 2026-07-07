/**
 * Developer API key management — list + create.
 *
 * Both handlers are gated by `withAuth()` (WorkOS AuthKit). Anonymous callers
 * get a 401; the public weather/embed API stays key-free and anonymous.
 *
 *   GET  /api/keys  → list the signed-in user's keys (masked, never the raw value)
 *   POST /api/keys  → mint a new key; returns the FULL key exactly once
 *
 * Ownership is enforced by resolving the WorkOS user to their canonical
 * `identity.persons._id` (`ownerPersonId`) and scoping every query to it, plus
 * `surfaceContext: "mukoko-weather"` + `keyType: "external"`. Keys live in the
 * platform-wide `platform.apiKeys` collection. The raw key is never logged and
 * never stored — only a SHA-256 `keyHashedSecret` plus a short display prefix.
 *
 * NOTE: key-based enforcement on the public API is intentionally NOT wired up
 * yet. This surface is create/list/revoke + the gated UI only; enforcing
 * higher limits per key is a follow-up.
 */

import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { WorkOSUser } from "@/lib/auth";
import {
  countDeveloperApiKeys,
  createDeveloperApiKey,
  listDeveloperApiKeys,
  resolveOwnerPersonId,
  resolveOwnerEntityId,
  sanitizeLabel,
  MAX_KEYS_PER_USER,
} from "@/lib/api-keys";

export const dynamic = "force-dynamic";

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "unauthorized", message: "Sign in to manage API keys." },
    { status: 401 },
  );
}

export async function GET(): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return unauthorized();

  const personId = await resolveOwnerPersonId(user as WorkOSUser);
  const [keys, entity] = await Promise.all([
    listDeveloperApiKeys(personId),
    resolveOwnerEntityId(personId),
  ]);
  // `entityRequired` lets the UI render the "register an entity" guidance
  // up-front, before the user attempts to create a key.
  return NextResponse.json({ keys, entityRequired: entity === null });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return unauthorized();

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const rawLabel =
    body && typeof body === "object" && "label" in body
      ? (body as { label?: unknown }).label
      : "";
  const label = sanitizeLabel(rawLabel);
  if (!label) {
    return NextResponse.json(
      {
        error: "invalid_label",
        message: "A non-empty label (max 60 characters) is required.",
      },
      { status: 400 },
    );
  }

  const personId = await resolveOwnerPersonId(user as WorkOSUser);

  // A key is owned by the developer's own entity — they must be a
  // founder/admin/manager/representative of a registered entity to mint one.
  const entity = await resolveOwnerEntityId(personId);
  if (!entity) {
    return NextResponse.json(
      {
        error: "entity_required",
        message:
          "You must be a founder, admin, manager, or representative of a registered entity to create an API key.",
      },
      { status: 403 },
    );
  }

  const existing = await countDeveloperApiKeys(personId);
  if (existing >= MAX_KEYS_PER_USER) {
    return NextResponse.json(
      {
        error: "key_limit_reached",
        message: `You can have at most ${MAX_KEYS_PER_USER} API keys. Revoke one to create another.`,
      },
      { status: 429 },
    );
  }

  const { fullKey, key } = await createDeveloperApiKey(
    personId,
    label,
    entity.entityId,
  );
  // `fullKey` is returned ONCE here and never again — the UI must surface it now.
  return NextResponse.json({ key, fullKey }, { status: 201 });
}
