"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { NavigationIcon } from "@/lib/weather-icons";
import { MY_LOCATION_HREF, MY_LOCATION_NAME } from "@/lib/location-pager";
import { handlePlaceLinkClick } from "@/lib/place-bus";
import { cn } from "@/lib/utils";

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
 * My Location: the location arrow, a link to the current-location page (`/`).
 * One component for both homes of the control on a phone (owner, 2026-11-05:
 * the avatar and My Location swapped places): the hero's top-right group beside
 * Share, and the header's action pill on the pages that have no hero, so it is
 * reachable on every phone page. (The account avatar took its old place, the
 * first slot of the bottom bar: see PhoneMenu.)
 *
 * A real link (`href`, so a new tab, a middle click and no-JS work). A plain
 * left click is turned into an in-place switch by the place stage when one is
 * mounted (`handlePlaceLinkClick`, the same call the places lane's chips make),
 * else the router navigates. `aria-current="page"` on `/`, where the glyph is
 * filled. Moving to My Location sends no `location_changed` event, as before:
 * `/` is not a saved slug (`trackPlaceChange`).
 */
export function MyLocationLink({ className, iconClassName }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const current = pathname === MY_LOCATION_HREF;

  return (
    <Link
      href={MY_LOCATION_HREF}
      prefetch={false}
      aria-label={MY_LOCATION_NAME}
      aria-current={current ? "page" : undefined}
      title={MY_LOCATION_NAME}
      onClick={(event) =>
        handlePlaceLinkClick(event, MY_LOCATION_HREF, (href) =>
          router.push(href),
        )
      }
      className={className}
    >
      <NavigationIcon
        size={20}
        className={cn(iconClassName, current && "fill-current")}
      />
    </Link>
  );
}
