"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LocationsLink } from "@/components/layout/LocationsLink";
import { NotificationsButton } from "@/components/layout/NotificationsButton";
import { ShareControl } from "@/components/weather/ShareControl";
import { useSkyHero, watchSkyBehindGroup } from "@/lib/sky-hero";

/**
 * How the group looks, chosen by the background it sits on (owner,
 * 2026-11-11: "based on the background the group is clear or has a solid
 * color").
 *
 * - `clear`: no fill, no border, no shadow; the icons take the sky hero's own
 *   foreground. Only for a group over the sky.
 * - `solid`: the brand-colour pill. For every other background.
 * - `auto`: clear while bare sky of a place page's hero is behind the group
 *   (at the top of the page: the hero's first line of content has not reached
 *   the group yet), solid otherwise (see the rule in globals.css, `.hadeda`).
 */
export type QuickActionsTone = "clear" | "solid" | "auto";

/**
 * Where the group sits. `header`: the top right of every page that has the
 * site header (at the header's right edge from `sm`, the float grid's corner
 * on a phone). `float`: the float grid's top right corner at every width, for
 * the pages that take the whole screen and have no header (the weather map).
 */
export type QuickActionsPlacement = "header" | "float";

export const QUICK_ACTIONS_LABEL = "Quick actions";

interface Props {
  tone?: QuickActionsTone;
  placement?: QuickActionsPlacement;
  /**
   * Controls that follow the three shared ones in the same pill. The header
   * passes Map and Account for desktop, which has no bottom bar to hold them;
   * everywhere else the group is exactly the three.
   */
  extra?: ReactNode;
}

/**
 * The Quick actions group: Share, Notifications, Locations. The same three
 * controls, in this order, with the same icons, names and 49px targets, on
 * every page (owner, 2026-11-11). Mounted ONCE for the whole app, from the
 * root layout's chrome (SiteHeader, or AppChrome on the map page that has no
 * header), so there is never a second group and never a second notifications
 * centre. Never render it twice and hide one with CSS: both would mount.
 *
 * The group is `position: fixed` (the `.hadeda` rule), outside the `<header>`
 * (a header with a backdrop-filter would capture a fixed child). It holds no
 * state of its own about the page: the sky hero registers itself (see
 * `lib/sky-hero.ts`), and with `tone="auto"` the group asks an
 * IntersectionObserver whether the sky is still behind it.
 */
export function QuickActions({
  tone = "auto",
  placement = "header",
  extra,
}: Props) {
  const groupRef = useRef<HTMLDivElement>(null);
  const hero = useSkyHero();
  const content = hero?.content ?? null;

  // Whether bare sky is still behind the group (the hero's first line of
  // content has not reached it), for the hero last observed. A new hero starts as "behind"
  // (the page opens at the top), so a place switch never flashes the solid
  // look while the observer answers.
  const [seen, setSeen] = useState<{
    content: HTMLElement | null;
    behind: boolean;
  }>({ content: null, behind: true });
  const behind = seen.content === content ? seen.behind : true;

  useEffect(() => {
    const group = groupRef.current;
    if (tone !== "auto" || !content || !group) return;
    return watchSkyBehindGroup({
      content,
      group,
      onChange: (next) => setSeen({ content, behind: next }),
    });
  }, [tone, content]);

  return (
    <div
      ref={groupRef}
      role="toolbar"
      aria-label={QUICK_ACTIONS_LABEL}
      data-quick-actions
      data-tone={tone}
      data-placement={placement}
      data-past-sky={tone === "auto" && !behind ? "" : undefined}
      className="hadeda"
    >
      <ShareControl place={hero?.place ?? null} />
      <NotificationsButton />
      <LocationsLink className="bee" />
      {extra}
    </div>
  );
}
