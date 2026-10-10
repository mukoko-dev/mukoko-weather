/**
 * The signed-in user's own profile — read from the platform, not the session.
 *
 * Follows the Mukoko ecosystem profile standard (mukoko-news
 * `src/lib/actions/profile.ts` + `src/lib/mongodb/identity.ts`, mukoko-events
 * `src/app/actions/profile.ts`): `identity.persons` is the canonical person
 * record every Mukoko app renders, matched on `workosUserId`. It carries more
 * than the WorkOS session claims (the picture lives on
 * profile-images.mukoko.com, plus `preferredUsername` / `interests`), so each
 * field prefers the record and falls back to the session claim per-field.
 *
 * Reads are fail-soft: a degraded cluster yields the session-claim profile and
 * an empty organisation list, so `/profile` still renders rather than 500ing.
 *
 * Writes are scoped to the caller's OWN record (matched on the verified
 * `workosUserId`, never a client-supplied id) and an allowlist of
 * person-owned fields. No upsert — the person record is created on sign-in by
 * `upsertPlatformPerson`; creating one here could race that and mint a second
 * record for the same human.
 */

import { personsCollection, entityMembershipsCollection } from "./db";
import { logError } from "./observability";
import type { WorkOSUser } from "./auth";
import { capabilitiesForRole, type EntityCapability } from "./user-display";

/** The person fields `/profile` reads (mirrors mukoko-news `MyProfile`). */
export interface MyProfile {
  personId: string | null;
  givenName: string | null;
  familyName: string | null;
  name: string | null;
  preferredUsername: string | null;
  picture: string | null;
  interests: string[];
}

/** One organisation the caller belongs to, and what that membership allows. */
export interface ProfileOrganization {
  entityId: string;
  entityName: string | null;
  entityType: string | null;
  role: string | null;
  title: string | null;
  capabilities: EntityCapability[];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The signed-in user's profile: `identity.persons` first, each field falling
 * back to the WorkOS session claim until the record carries it.
 */
export async function getMyProfile(user: WorkOSUser): Promise<MyProfile> {
  const fallback: MyProfile = {
    personId: null,
    givenName: user.firstName ?? null,
    familyName: user.lastName ?? null,
    name: null,
    preferredUsername: null,
    picture: user.profilePictureUrl ?? null,
    interests: [],
  };

  try {
    const doc = (await personsCollection().findOne(
      { workosUserId: user.id, isActive: { $ne: false } },
      {
        projection: {
          _id: 1,
          givenName: 1,
          familyName: 1,
          name: 1,
          preferredUsername: 1,
          picture: 1,
          interests: 1,
        },
      },
    )) as Record<string, unknown> | null;
    if (!doc) return fallback;

    return {
      personId: typeof doc._id === "string" ? doc._id : null,
      givenName: toStringOrNull(doc.givenName) ?? fallback.givenName,
      familyName: toStringOrNull(doc.familyName) ?? fallback.familyName,
      name: toStringOrNull(doc.name),
      preferredUsername: toStringOrNull(doc.preferredUsername),
      picture: toStringOrNull(doc.picture) ?? fallback.picture,
      interests: Array.isArray(doc.interests)
        ? doc.interests.filter((i): i is string => typeof i === "string")
        : [],
    };
  } catch (error) {
    logError({
      source: "mongodb",
      severity: "low",
      message: "getMyProfile: identity.persons read failed",
      error,
    });
    return fallback;
  }
}

/**
 * The caller's active `entity.memberships`, with the organisation name and
 * type resolved from `entity.entities`. Memberships whose role grants no
 * capability are dropped. Fail-soft: an empty list means "cannot prove
 * membership", never "proven to have none" — it grants nothing.
 */
export async function getMyOrganizations(
  personId: string | null,
): Promise<ProfileOrganization[]> {
  if (!personId) return [];
  try {
    const rows = (await entityMembershipsCollection()
      .aggregate([
        {
          $match: {
            personId,
            isActive: true,
            $or: [
              { endedAt: null },
              { endedAt: { $exists: false } },
              { endedAt: { $gt: new Date() } },
            ],
          },
        },
        {
          $lookup: {
            from: "entities",
            localField: "entityId",
            foreignField: "_id",
            as: "entity",
          },
        },
        {
          $project: {
            _id: 0,
            entityId: 1,
            role: "$membershipRole",
            title: 1,
            entityName: { $first: "$entity.name" },
            entityType: { $first: "$entity.entityType" },
          },
        },
      ])
      .toArray()) as Array<Record<string, unknown>>;

    return rows
      .map((r) => {
        const role = toStringOrNull(r.role);
        return {
          entityId: String(r.entityId),
          entityName: toStringOrNull(r.entityName),
          entityType: toStringOrNull(r.entityType),
          role,
          title: toStringOrNull(r.title),
          capabilities: capabilitiesForRole(role),
        };
      })
      .filter((o) => o.capabilities.length > 0);
  } catch (error) {
    logError({
      source: "mongodb",
      severity: "low",
      message: "getMyOrganizations: entity.memberships read failed",
      error,
    });
    return [];
  }
}

/**
 * Write the caller's own given/family name to `identity.persons`. Returns
 * `false` when no record matched or the write failed.
 */
export async function updateMyName(
  workosUserId: string,
  givenName: string,
  familyName: string,
): Promise<boolean> {
  try {
    const result = await personsCollection().updateOne(
      { workosUserId, isActive: { $ne: false } },
      {
        $set: {
          givenName,
          familyName,
          // The joined display form — the same shape mukoko-news writes.
          name: [givenName, familyName].filter(Boolean).join(" "),
          updatedAt: new Date(),
        },
      },
    );
    return result.matchedCount > 0;
  } catch (error) {
    logError({
      source: "mongodb",
      severity: "medium",
      message: "updateMyName: identity.persons write failed",
      error,
    });
    return false;
  }
}
