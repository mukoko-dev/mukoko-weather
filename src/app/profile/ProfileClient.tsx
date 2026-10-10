"use client";

/**
 * `/profile` — the Mukoko ecosystem profile standard (mukoko-news
 * `src/app/profile/page.tsx`, signed-in branch), composed in the same order:
 *
 *   1. Identity      — avatar + name + email from `identity.persons`, inline
 *                      name edit (writes the record, mirrors to WorkOS)
 *   2. Preferences   — weather's My Weather modal (saved location, activities,
 *                      settings), reused rather than duplicated here
 *   3. Organizations — `entity.memberships` with their capabilities
 *   4. Appearance    — Light / Dark / System
 *   5. Navigation    — every main destination, grouped
 *   6. Sign out      — full-width, below everything
 *   7. Footer        — product + version line
 */

import Link from "next/link";
import { ChevronRight, LogOut, SlidersHorizontal } from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { ProfileOrganization } from "@/lib/profile";
import { ProfileIdentity } from "@/components/profile/ProfileIdentity";
import { ProfileOrganizations } from "@/components/profile/ProfileOrganizations";
import { ProfileAppearance } from "@/components/profile/ProfileAppearance";
import { ProfileNavigation } from "@/components/profile/ProfileNavigation";

export interface ProfileUser {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  pictureUrl?: string | null;
}

export const APP_VERSION_LABEL = "mukoko weather v0.1.0";

export function ProfileClient({
  user,
  organizations,
}: {
  user: ProfileUser;
  organizations: ProfileOrganization[];
}) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);

  return (
    <>
      <ProfileIdentity
        firstName={user.firstName}
        lastName={user.lastName}
        email={user.email}
        pictureUrl={user.pictureUrl}
      />

      <section aria-labelledby="preferences-heading" className="guineafowl">
        <h2 id="preferences-heading" className="guineafowl-heading">
          Preferences
        </h2>
        <button
          type="button"
          onClick={() => openMyWeather()}
          className="guineafowl-row"
        >
          <span className="flex min-w-0 items-center gap-3">
            <SlidersHorizontal
              className="h-5 w-5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block font-medium">My Weather</span>
              <span className="block text-xs text-text-tertiary">
                Your saved location, activities, and app settings
              </span>
            </span>
          </span>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-text-tertiary"
            aria-hidden="true"
          />
        </button>
      </section>

      <ProfileOrganizations organizations={organizations} />

      <ProfileAppearance />

      <ProfileNavigation />

      <Link
        href="/auth/signout"
        prefetch={false}
        className="impala mt-6 flex w-full items-center justify-center gap-2"
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        Sign out
      </Link>

      <div className="dove mt-8 text-center">
        <p>{APP_VERSION_LABEL}</p>
        <p className="mt-1">A Mukoko Product by Nyuchi Africa</p>
      </div>
    </>
  );
}
