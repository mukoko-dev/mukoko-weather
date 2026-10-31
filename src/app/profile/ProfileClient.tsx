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
 *   3b. Devices      — where the person is signed in, this device's permissions
 *   4. Appearance    — Light / Dark / System
 *   5. Navigation    — every main destination, grouped
 *   6. Sign out      — full-width, below everything
 *   7. Footer        — product + version line
 */

import { LogOut, SlidersHorizontal } from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { ProfileOrganization } from "@/lib/profile";
import { ProfileIdentity } from "@/components/profile/ProfileIdentity";
import { ProfileGroup } from "@/components/profile/ProfileGroup";
import { GroupedRow } from "@/components/profile/GroupedRow";
import { ProfileOrganizations } from "@/components/profile/ProfileOrganizations";
import { ProfileDevices } from "@/components/profile/ProfileDevices";
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
  const savedCount = useAppStore((s) => s.savedLocations.length);
  const activityCount = useAppStore((s) => s.selectedActivities.length);
  const preferencesValue = `${savedCount} ${savedCount === 1 ? "place" : "places"} · ${activityCount} ${activityCount === 1 ? "activity" : "activities"}`;

  return (
    <>
      <ProfileIdentity
        firstName={user.firstName}
        lastName={user.lastName}
        email={user.email}
        pictureUrl={user.pictureUrl}
      />

      <ProfileGroup id="preferences-heading" title="Preferences">
        <GroupedRow
          icon={SlidersHorizontal}
          label="My Weather"
          value={preferencesValue}
          onClick={() => openMyWeather()}
        />
      </ProfileGroup>

      <ProfileOrganizations organizations={organizations} />

      <ProfileDevices />

      <ProfileAppearance />

      <ProfileNavigation />

      <div className="guineafowl-card">
        <GroupedRow
          icon={LogOut}
          label="Sign out"
          href="/auth/signout"
          prefetch={false}
          tone="danger"
          chevron={false}
        />
      </div>

      <div className="dove mt-8 text-center">
        <p>{APP_VERSION_LABEL}</p>
        <p className="mt-1">A Mukoko Product by Nyuchi Africa</p>
      </div>
    </>
  );
}
