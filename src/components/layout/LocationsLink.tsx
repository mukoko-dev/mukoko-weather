"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { List as ListIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Where the Locations list lives. */
export const LOCATIONS_HREF = "/locations";

/** The control's accessible name and tooltip. */
export const LOCATIONS_LABEL = "All locations";

interface Props {
  /**
   * The round control's class: `duiker` in the hero's phone icon group
   * (`.hadeda`), `bee` and `sm:hidden` in the header's action pill.
   */
  className: string;
  /** Colour of the glyph on its surface (the header pill's is on-primary). */
  iconClassName?: string;
}

/**
 * Locations: the list icon, a link to the Locations list (`/locations`). One
 * component for both homes of the control on a phone (owner, 2026-11-11: the
 * Locations icon moves to the top right of the screen): the hero's top-right
 * group beside Share, and the header's action pill on the pages that have no
 * hero, so it is reachable on every phone page. It left the bottom bar, which
 * now ends with the account avatar (see PhoneMenu).
 *
 * A plain link (`href`, so a new tab, a middle click and no-JS work);
 * `/locations` is not a place, so the place stage never takes it over.
 * `aria-current="page"` on the list itself.
 */
export function LocationsLink({ className, iconClassName }: Props) {
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
        className={cn(iconClassName, current && "stroke-[2.6]")}
      />
    </Link>
  );
}
