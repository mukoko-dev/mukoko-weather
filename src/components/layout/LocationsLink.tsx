"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { List as ListIcon } from "lucide-react";

/** Where the Locations list lives. */
export const LOCATIONS_HREF = "/locations";

/** The control's accessible name and tooltip. */
export const LOCATIONS_LABEL = "All locations";

interface Props {
  /** The round control's class: `bee`, in the Quick actions group. */
  className: string;
}

/**
 * Locations: the list icon, a link to the Locations list (`/locations`), the
 * third control of the Quick actions group (Share, Notifications, Locations:
 * the same on every page, owner 2026-11-11, see QuickActions). It left the
 * bottom bar on 2026-11-11, which now ends with the account avatar (see
 * PhoneMenu).
 *
 * A plain link (`href`, so a new tab, a middle click and no-JS work);
 * `/locations` is not a place, so the place stage never takes it over.
 * `aria-current="page"` on the list itself.
 */
export function LocationsLink({ className }: Props) {
  const pathname = usePathname();
  const current = pathname === LOCATIONS_HREF;

  return (
    <Link
      href={LOCATIONS_HREF}
      prefetch={false}
      aria-label={LOCATIONS_LABEL}
      aria-current={current ? "page" : undefined}
      title={LOCATIONS_LABEL}
      className={className}
    >
      <ListIcon
        size={20}
        aria-hidden="true"
        className={current ? "stroke-[2.6]" : undefined}
      />
    </Link>
  );
}
