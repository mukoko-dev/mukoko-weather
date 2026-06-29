"use client";

/**
 * Header auth slot — renders the signed-in user's avatar + Sign out, or a
 * Sign in link when anonymous.
 *
 * Why a client component (vs. an RSC reading `await withAuth()`)?
 * The parent `Header` is a client component (it owns Zustand state, scroll
 * listeners, and modal triggers), so we cannot directly render a server
 * component inside it. We use AuthKit's `useAuth()` hook instead, hydrated
 * via `<AuthKitProvider initialAuth={…}>` in the root layout so there's no
 * client-side fetch waterfall on first paint.
 *
 * Fauna classes used:
 *   - `.hoopoe` — round avatar circle (initials or profile picture)
 *   - `.kudu-sm` — primary pill (Sign in)
 *   - `.impala` — secondary pill (Sign out)
 */

import Link from "next/link";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

export interface UserMenuUser {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

export interface UserMenuProps {
  /**
   * Optional pre-resolved user — when set, the menu skips the AuthKit hook
   * lookup entirely (useful for tests and storybook).
   * In normal usage, leave undefined and let `useAuth()` provide the value.
   */
  user?: UserMenuUser | null;
  /** Compact mode hides the email label on small screens. Default: true. */
  compact?: boolean;
}

function initialsFor(user: UserMenuUser): string {
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

export function UserMenu({ user: userProp, compact = true }: UserMenuProps) {
  // `useAuth()` is safe to call when AuthKitProvider is mounted.
  // When `userProp` is provided we still call the hook (rules of hooks),
  // but prefer the explicit prop.
  const auth = useAuth();
  const user: UserMenuUser | null = userProp ?? (auth.user as UserMenuUser | null) ?? null;

  // ── Signed out ────────────────────────────────────────────────────────
  if (!user) {
    return (
      <Link
        href="/auth/signin"
        prefetch={false}
        aria-label="Sign in"
        className="kudu-sm"
      >
        Sign in
      </Link>
    );
  }

  // ── Signed in ─────────────────────────────────────────────────────────
  const initials = initialsFor(user);
  const displayName =
    user.email ??
    [user.firstName, user.lastName].filter(Boolean).join(" ") ??
    "Signed in";
  const hasPicture = Boolean(user.profilePictureUrl);

  return (
    <div
      className="flex items-center gap-2"
      role="group"
      aria-label="Signed in user menu"
    >
      <span
        className="hoopoe overflow-hidden text-xs font-medium text-primary"
        aria-hidden="true"
      >
        {hasPicture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.profilePictureUrl ?? ""}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span>{initials}</span>
        )}
      </span>
      {!compact && (
        <span className="dove max-w-[12rem] truncate" title={displayName}>
          {displayName}
        </span>
      )}
      <Link
        href="/auth/signout"
        prefetch={false}
        aria-label={`Sign out${user.email ? ` (${user.email})` : ""}`}
        className="impala text-sm"
      >
        Sign out
      </Link>
    </div>
  );
}
