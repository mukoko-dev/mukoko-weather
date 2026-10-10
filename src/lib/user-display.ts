/**
 * Shared client-safe helpers for displaying a WorkOS-authenticated user.
 * Used by the header avatar and the profile page so the initials/display-name
 * logic isn't duplicated across components.
 */

export interface PublicUser {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

export function initialsFor(user: PublicUser): string {
  const first = (user.firstName ?? "").trim();
  const last = (user.lastName ?? "").trim();
  if (first || last) {
    const f = first.charAt(0).toUpperCase();
    const l = last.charAt(0).toUpperCase();
    return `${f}${l}` || f || l;
  }
  const email = (user.email ?? "").trim();
  if (email) return email.charAt(0).toUpperCase();
  return "?";
}

export function displayNameFor(user: PublicUser): string {
  return (
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    "Signed in"
  );
}

/**
 * True only for an image URL the profile avatar may render: an in-app path or
 * an http(s) URL. Anything else (javascript:, data:, garbage) falls back to
 * initials — same guard mukoko-news applies to `identity.persons.picture`.
 */
export function isValidImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Profile name editing — shared by the client form and the server action so
// the two can't disagree on what a valid name is.
// ---------------------------------------------------------------------------

/** Longest given/family name the profile accepts (matches mukoko-news). */
export const MAX_PROFILE_NAME_LENGTH = 60;

/**
 * Normalise a display-name part: strip control characters and trim. Returns
 * `null` when the result is longer than {@link MAX_PROFILE_NAME_LENGTH}.
 */
export function sanitizeProfileName(raw: unknown): string | null {
  if (typeof raw !== "string") return "";
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return clean.length <= MAX_PROFILE_NAME_LENGTH ? clean : null;
}

// ---------------------------------------------------------------------------
// Organisations (entity.memberships) — role → capability labels, mirrored
// from mukoko-news's entity-access model so every Mukoko profile states the
// same scope in the same words.
// ---------------------------------------------------------------------------

export type EntityCapability =
  | "entity:read"
  | "entity:manage"
  | "entity:members";

export const CAPABILITY_LABELS: Record<EntityCapability, string> = {
  "entity:read": "View",
  "entity:manage": "Manage",
  "entity:members": "Members",
};

const ROLE_CAPABILITIES: Record<string, readonly EntityCapability[]> = {
  founder: ["entity:read", "entity:manage", "entity:members"],
  owner: ["entity:read", "entity:manage", "entity:members"],
  admin: ["entity:read", "entity:manage", "entity:members"],
  editor: ["entity:read", "entity:manage"],
  manager: ["entity:read", "entity:manage"],
  member: ["entity:read"],
  viewer: ["entity:read"],
};

/** Capabilities a membership role grants on its own entity (unknown → none). */
export function capabilitiesForRole(
  role: string | null | undefined,
): EntityCapability[] {
  if (!role) return [];
  return [...(ROLE_CAPABILITIES[role.trim().toLowerCase()] ?? [])];
}

/**
 * The line under an organisation's name: the free-text `title` verbatim when
 * present, else the `membershipRole` enum in sentence case.
 */
export function roleLabel(
  title: string | null | undefined,
  role: string | null | undefined,
): string {
  if (title && title.trim()) return title.trim();
  if (!role || !role.trim()) return "Member";
  const trimmed = role.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}
