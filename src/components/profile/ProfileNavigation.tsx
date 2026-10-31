/**
 * Every main destination in the app, on the page a user already treats as
 * "settings" — Mukoko ecosystem profile standard (mukoko-news
 * `src/components/profile/profile-navigation.tsx`; mukoko-events renders the
 * same grouped rows as its Events / Account / Support menu sections).
 *
 * The destinations come from `src/lib/nav-destinations.ts`, so the header,
 * footer and this page can't disagree about a route. Groups render as
 * `.guineafowl` cards.
 */

import { NAV_GROUPS, PROFILE_DESTINATIONS } from "@/lib/nav-destinations";
import { GroupedRow } from "@/components/profile/GroupedRow";
import { ProfileGroup } from "@/components/profile/ProfileGroup";

// The profile page's destinations and groups live in lib/nav-destinations;
// re-exported under the names the existing tests import.
export {
  NAV_GROUPS as PROFILE_NAV_GROUPS,
  PROFILE_DESTINATIONS,
} from "@/lib/nav-destinations";

export function ProfileNavigation() {
  return (
    <nav aria-label="All pages" className="mb-6">
      {NAV_GROUPS.map((group) => {
        const items = PROFILE_DESTINATIONS.filter((d) => d.group === group.id);
        if (items.length === 0) return null;
        const headingId = `profile-nav-${group.id}`;
        return (
          <ProfileGroup key={group.id} id={headingId} title={group.label}>
            <ul>
              {items.map((d) => (
                <li key={d.href}>
                  <GroupedRow
                    href={d.href}
                    icon={d.icon}
                    label={d.label}
                    description={d.description}
                  />
                </li>
              ))}
            </ul>
          </ProfileGroup>
        );
      })}
    </nav>
  );
}
