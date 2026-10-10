/**
 * The organisations the signed-in user belongs to, and what each membership
 * lets them do — Mukoko ecosystem profile standard (mukoko-news
 * `src/components/profile/profile-organizations.tsx`; mukoko-events lists the
 * same memberships as "Host Entities").
 *
 * States the scope in plain words: these are powers over that one
 * organisation. Renders nothing when there are none — including when the read
 * failed (it is fail-soft), since an empty card claiming "no organisations"
 * would state as fact something the app cannot prove.
 *
 * Presentational only: `/profile` resolves the list server-side
 * (`getMyOrganizations` in `src/lib/profile.ts`) and passes it in.
 */

import { Building2, Home } from "lucide-react";
import { CAPABILITY_LABELS, roleLabel } from "@/lib/user-display";
import type { ProfileOrganization } from "@/lib/profile";

export function ProfileOrganizations({
  organizations,
}: {
  organizations: ProfileOrganization[];
}) {
  if (organizations.length === 0) return null;

  return (
    <section aria-labelledby="profile-organizations" className="guineafowl">
      <h2 id="profile-organizations" className="guineafowl-heading">
        Your organizations
      </h2>
      <ul>
        {organizations.map((org) => {
          const Icon = org.entityType === "family" ? Home : Building2;
          return (
            <li
              key={org.entityId}
              className="flex items-start gap-3 border-b border-border px-4 py-4 last:border-b-0"
            >
              <span
                className="hoopoe-lg bg-container-sodalite"
                aria-hidden="true"
              >
                <Icon className="h-4 w-4 text-on-container-sodalite" />
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium text-text-primary">
                  {org.entityName ?? "Unnamed organization"}
                </span>
                <span className="text-xs text-text-secondary">
                  {roleLabel(org.title, org.role)}
                </span>
                <ul
                  aria-label="Permissions"
                  className="mt-2 flex flex-wrap gap-1.5"
                >
                  {org.capabilities.map((cap) => (
                    <li
                      key={cap}
                      className="rounded-full bg-surface-dim px-2 py-0.5 font-mono text-xs text-text-secondary"
                    >
                      {CAPABILITY_LABELS[cap]}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-4 py-3 text-xs text-text-secondary">
        These permissions apply to each organization on its own.
      </p>
    </section>
  );
}
