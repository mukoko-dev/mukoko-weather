/**
 * Server-side WorkOS AuthKit helpers + identity.persons upsert.
 *
 * Mukoko-weather does not own its users — they live in the shared platform
 * `identity` database. This module is the bridge: a WorkOS sign-in event
 * lands on `/callback`, AuthKit hands us a WorkOS user, and we upsert it
 * into `identity.persons` (deduped by `workosUserId`, falling back to
 * `email` for legacy records).
 *
 * Dedup discipline (Phase 0E lesson):
 *   - persons:     dedupe by `workosUserId`, then by `email`.
 *                  NEVER create two persons docs for the same WorkOS user.
 *   - credentials: dedupe by `(personId, provider, credentialType)`.
 *                  NEVER create two "workos oauth_token" credentials
 *                  for the same person.
 *
 * See docs/mongodb-schema-map.md → `identity` for the full schema.
 */

import {
  withAuth,
  getSignInUrl,
  signOut,
} from "@workos-inc/authkit-nextjs";
import {
  personsCollection,
  credentialsCollection,
  activityLogCollection,
  stampPlatformFields,
} from "./db";
import { logError, logWarn } from "./observability";

export { getSignInUrl, signOut };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the WorkOS user we rely on.
 * AuthKit's `withAuth()` returns this (plus a few extras we don't use here).
 */
export interface WorkOSUser {
  id: string;
  email: string;
  emailVerified?: boolean | null;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

/**
 * The `identity.persons` document we read/write. OIDC-compliant: `_id`
 * doubles as the OIDC `sub` claim. Fields below are the ones mukoko
 * directly cares about; the platform schema is wider.
 */
export interface PlatformPersonDoc {
  _id: string;
  _schemaVersion: string;
  workosUserId: string;
  email?: string;
  emailVerified: boolean;
  phoneNumberVerified: boolean;
  isActive: boolean;
  givenName?: string;
  familyName?: string;
  picture?: string;
  locale?: string;
  zoneinfo?: string;
  bundu?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertPersonResult {
  person: PlatformPersonDoc;
  /** True when a brand-new persons doc was inserted; false on update. */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Session accessors — server-only helpers used by RSC, server actions, routes.
// ---------------------------------------------------------------------------

/**
 * Get the currently-signed-in WorkOS user, or `null` if anonymous.
 * Safe to call from any server component / route handler / server action.
 */
export async function getCurrentUser(): Promise<WorkOSUser | null> {
  const { user } = await withAuth();
  return (user as WorkOSUser | null) ?? null;
}

/**
 * Require a signed-in user; redirects to the WorkOS sign-in flow if not.
 * Returns the WorkOS user object — guaranteed non-null on a successful return.
 */
export async function requireUser(): Promise<WorkOSUser> {
  const { user } = await withAuth({ ensureSignedIn: true });
  // `ensureSignedIn: true` either returns a user or throws/redirects.
  return user as WorkOSUser;
}

// ---------------------------------------------------------------------------
// identity.persons upsert
// ---------------------------------------------------------------------------

/**
 * Upsert a platform `identity.persons` document for the given WorkOS user.
 *
 * Dedup order:
 *   1. Look up by `workosUserId` (preferred — the OIDC subject identifier).
 *   2. If none, look up by `email` (legacy hand-seeded records).
 *   3. Otherwise insert a fresh person and stamp `_id` (UUID, also OIDC sub).
 *
 * Side effects on every call:
 *   - Upsert a `credentials` doc with `provider: "workos",
 *     credentialType: "oauth_token"` (dedup on `(personId, provider, type)`).
 *   - Append an `activityLog` entry with `eventType: "signup"` on first
 *     insert, `eventType: "signin"` on subsequent calls.
 *     `surfaceContext: "mukoko-weather"` so the platform can split per-app
 *     auth analytics.
 *
 * The credentials and activityLog writes are best-effort — failures are
 * logged but do not throw, because the user is already authenticated and
 * blocking sign-in on an audit-log write would be hostile.
 */
export async function upsertPlatformPerson(
  workosUser: WorkOSUser,
): Promise<UpsertPersonResult> {
  if (!workosUser?.id) {
    throw new Error("upsertPlatformPerson: workosUser.id is required");
  }

  const persons = personsCollection();
  const now = new Date();

  // ── Step 1: locate existing person ─────────────────────────────────────
  // findOneAndUpdate on workosUserId would be cleaner, but we need to also
  // claim legacy email-only records, so we do explicit lookups.
  let existing = (await persons.findOne({
    workosUserId: workosUser.id,
  })) as unknown as PlatformPersonDoc | null;

  if (!existing && workosUser.email) {
    const byEmail = (await persons.findOne({
      email: workosUser.email,
      $or: [{ workosUserId: null }, { workosUserId: { $exists: false } }],
    })) as unknown as PlatformPersonDoc | null;
    if (byEmail) {
      logWarn({
        source: "mongodb",
        message:
          "Linking WorkOS user to existing email-only person record (legacy reclaim)",
        meta: { workosUserId: workosUser.id, personId: byEmail._id },
      });
      existing = byEmail;
    }
  }

  // Sanity safeguard: if two persons exist with the same WorkOS ID, log it.
  // We never knowingly create duplicates; this only fires on legacy corruption.
  const dupCount = await persons
    .countDocuments({ workosUserId: workosUser.id })
    .catch(() => 0);
  if (dupCount > 1) {
    logWarn({
      source: "mongodb",
      message:
        "Multiple persons docs share the same workosUserId — investigate manually",
      meta: { workosUserId: workosUser.id, count: dupCount },
    });
  }

  // ── Step 2: build the OIDC-compliant fields we're about to write ───────
  const mutableFields: Record<string, unknown> = {
    workosUserId: workosUser.id,
    isActive: true,
    emailVerified: Boolean(workosUser.emailVerified),
    updatedAt: now,
  };
  if (workosUser.email) mutableFields.email = workosUser.email;
  if (workosUser.firstName) mutableFields.givenName = workosUser.firstName;
  if (workosUser.lastName) mutableFields.familyName = workosUser.lastName;
  if (workosUser.profilePictureUrl) {
    mutableFields.picture = workosUser.profilePictureUrl;
  }

  let person: PlatformPersonDoc;
  let created: boolean;

  if (existing) {
    // ── Update path ─────────────────────────────────────────────────────
    await persons.updateOne(
      { _id: existing._id } as Record<string, unknown>,
      { $set: mutableFields },
    );
    person = { ...existing, ...mutableFields } as PlatformPersonDoc;
    created = false;
  } else {
    // ── Insert path ─────────────────────────────────────────────────────
    // Strict validator requires: _id, _schemaVersion, isActive, emailVerified,
    // phoneNumberVerified, createdAt, updatedAt. stampPlatformFields covers
    // _id, _schemaVersion, createdAt, updatedAt, bundu.countryCode — we add
    // phoneNumberVerified (defaults to false) and the OIDC fields ourselves.
    const stamped = stampPlatformFields({
      ...mutableFields,
      phoneNumberVerified: false,
    });
    await persons.insertOne(stamped as unknown as Record<string, unknown>);
    person = stamped as unknown as PlatformPersonDoc;
    created = true;
  }

  // ── Step 3: credentials dedupe (fire-and-forget) ───────────────────────
  await upsertWorkOSCredential(person._id, workosUser).catch((err) =>
    logError({
      source: "mongodb",
      severity: "low",
      message: "Failed to upsert workos credential",
      error: err,
      meta: { personId: person._id },
    }),
  );

  // ── Step 4: activityLog (fire-and-forget) ──────────────────────────────
  await writeActivityLogEntry(person._id, created ? "signup" : "signin").catch(
    (err) =>
      logError({
        source: "mongodb",
        severity: "low",
        message: "Failed to append activityLog entry",
        error: err,
        meta: { personId: person._id },
      }),
  );

  return { person, created };
}

/**
 * Insert or refresh a `credentials` doc for the WorkOS OAuth token.
 * Dedupes on `(personId, provider, credentialType)` — never two
 * workos+oauth_token credentials for the same person.
 */
async function upsertWorkOSCredential(
  personId: string,
  workosUser: WorkOSUser,
): Promise<void> {
  const credentials = credentialsCollection();
  const now = new Date();

  const existing = await credentials.findOne({
    personId,
    provider: "workos",
    credentialType: "oauth_token",
  });

  if (existing) {
    await credentials.updateOne(
      { _id: (existing as { _id: unknown })._id } as Record<string, unknown>,
      {
        $set: {
          providerUserId: workosUser.id,
          isActive: true,
          updatedAt: now,
        },
      },
    );
    return;
  }

  const doc = stampPlatformFields({
    personId,
    provider: "workos",
    credentialType: "oauth_token",
    providerUserId: workosUser.id,
    isActive: true,
  });
  await credentials.insertOne(doc as unknown as Record<string, unknown>);
}

/**
 * Append an entry to `identity.activityLog`.
 * `surfaceContext: "mukoko-weather"` so this can be sliced per-app later.
 */
async function writeActivityLogEntry(
  personId: string,
  eventType: "signup" | "signin",
): Promise<void> {
  const activityLog = activityLogCollection();
  const doc = stampPlatformFields({
    personId,
    eventType,
    provider: "workos",
    source: "api",
    surfaceContext: "mukoko-weather",
    success: true,
  });
  await activityLog.insertOne(doc as unknown as Record<string, unknown>);
}
