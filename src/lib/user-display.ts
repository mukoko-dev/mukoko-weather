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
