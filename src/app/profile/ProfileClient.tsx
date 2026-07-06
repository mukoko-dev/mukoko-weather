"use client";

/**
 * Profile page content — account details (from WorkOS) + a link into the
 * existing My Weather preferences modal (location, activities, settings).
 *
 * My Weather intentionally reuses the existing modal rather than
 * duplicating its Location/Activities/Settings tabs here — the modal
 * already reads/writes the same Zustand-backed preferences used
 * app-wide (mobile bottom nav, header icon group), so this is just
 * another entry point into it.
 */

import Link from "next/link";
import { useAppStore } from "@/lib/store";
import {
  initialsFor,
  displayNameFor,
  type PublicUser,
} from "@/lib/user-display";

export type ProfileUser = PublicUser;

export function ProfileClient({ user }: { user: ProfileUser }) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const initials = initialsFor(user);
  const displayName = displayNameFor(user);
  const hasPicture = Boolean(user.profilePictureUrl);

  return (
    <div className="space-y-4">
      <section aria-labelledby="account-heading" className="baobab">
        <h2 id="account-heading" className="giraffe mb-4">
          Account
        </h2>
        <div className="flex items-center gap-4">
          <span
            className="hoopoe h-14 w-14 overflow-hidden text-lg font-medium text-primary"
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
          <div className="min-w-0">
            <p className="text-base font-medium text-text-primary truncate">
              {displayName}
            </p>
            {user.email && <p className="dove truncate">{user.email}</p>}
          </div>
        </div>
        <div className="mt-5">
          <Link href="/auth/signout" prefetch={false} className="impala-sm">
            Sign out
          </Link>
        </div>
      </section>

      <section aria-labelledby="preferences-heading" className="acacia">
        <h2 id="preferences-heading" className="giraffe mb-2">
          My Weather preferences
        </h2>
        <p className="gazelle mb-4">
          Your saved location, activities, and app settings.
        </p>
        <button type="button" onClick={openMyWeather} className="kudu-sm">
          Edit preferences
        </button>
      </section>
    </div>
  );
}
