"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  ACCOUNT_MENU_ROW_CLASS,
  AccountMenu,
} from "@/components/ui/app-account-menu";
import { Spinner } from "@/components/ui/spinner";
import { useAppStore } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { trackEvent } from "@/lib/analytics";
import { canShowHomeInPlace } from "@/lib/place-bus";
import {
  displayNameFor,
  initialsFor,
  type PublicUser,
} from "@/lib/user-display";
import {
  currentLocationSlug,
  isLocationSlug,
  CURRENT_LOCATION_EVENT,
  writeLastLocationCookie,
} from "@/lib/current-slug";
import {
  NOTIFICATIONS_LABEL,
  isDestinationActive,
  visibleHeaderDestinations,
  weatherMapHref,
} from "@/lib/header-nav";

interface Props {
  /**
   * Class of the round trigger: the bar's account control (`plover` + its
   * geometry, MobileNav.tsx). The trigger shows the Mzizi account avatar:
   * the profile photo or the initials when signed in, the user icon otherwise.
   */
  buttonClassName: string;
}

/**
 * The ONE phone menu: a thin wrapper around the Mzizi `app-account-menu`
 * (`src/components/ui/app-account-menu.tsx`). The registry component owns the
 * disclosure, the identity header and the sign-out form; this file only fills
 * its slot with the rows the site header carries — My Weather, Use my
 * location, the weather map, notifications and the header's destinations
 * (`HEADER_DESTINATIONS`) — and wires them to the app's store and routes, so
 * nothing is lost where the phone header is not drawn (over the sky hero).
 *
 * One wrapper, one home: the last slot of the phone bottom bar, at its far
 * right (owner, 2026-11-11; it was the first slot from 2026-11-05, when the
 * avatar and My Location swapped places). The menu opens UPWARD from the bar
 * (`panelPlacement`), from the bar's right edge, so it stays on screen over the
 * content instead of under a control at the top.
 */
export function PhoneMenu({ buttonClassName }: Props) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const openNotifications = useAppStore((s) => s.openNotifications);
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const authedUser = user as PublicUser | null;
  const [locating, setLocating] = useState(false);
  const groupId = useId();

  const destinations = visibleHeaderDestinations(isFeatureEnabled);
  const mapSlug = currentLocationSlug(pathname, selectedLocation);

  // Find where the user is right now (same GPS -> /v1/geo flow as My
  // Weather's "Use current location" button, autoCreate included), select it,
  // and land on the home page — the home page IS the current-location view and
  // refreshes GPS in place. On denial or failure the My Weather modal opens
  // instead: its Location tab has search plus a geolocation retry.
  const handleMyLocation = async () => {
    if (locating) return;
    setLocating(true);
    try {
      const { detectUserLocation } = await import("@/lib/geolocation");
      const result = await detectUserLocation({ autoCreate: true });
      trackEvent("geolocation_result", {
        status: result.status,
        location: result.location?.slug,
      });
      if (
        (result.status === "success" || result.status === "created") &&
        result.location &&
        isLocationSlug(result.location.slug)
      ) {
        trackEvent("location_changed", {
          from: currentLocationSlug(pathname, selectedLocation) ?? "",
          to: result.location.slug,
          method: "geolocation",
        });
        setSelectedLocation(result.location.slug);
        writeLastLocationCookie(result.location.slug);
        // A mounted home stage swaps (or returns to) My Location in place,
        // wherever the URL points; otherwise `/` is a normal navigation.
        if (pathname === "/" || canShowHomeInPlace()) {
          window.dispatchEvent(
            new CustomEvent(CURRENT_LOCATION_EVENT, {
              detail: result.location,
            }),
          );
        } else {
          router.push("/");
        }
      } else {
        openMyWeather();
      }
    } finally {
      setLocating(false);
    }
  };

  const groupLabel = (name: string) => `${groupId}-${name}`;

  return (
    <AccountMenu
      name={authedUser ? displayNameFor(authedUser) : null}
      email={authedUser?.email ?? null}
      initials={authedUser ? initialsFor(authedUser) : undefined}
      imageUrl={authedUser?.profilePictureUrl ?? null}
      signOutAction="/auth/signout"
      signInHref="/auth/signin"
      triggerClassName={buttonClassName}
      triggerLabel={
        authedUser
          ? `Account menu for ${displayNameFor(authedUser)}`
          : "Account menu"
      }
      panelPlacement="above"
    >
      <section aria-labelledby={groupLabel("account")}>
        <h2
          id={groupLabel("account")}
          className="guineafowl-heading !px-[var(--inset-floor)]"
        >
          Account
        </h2>
        <ul className="flex flex-col">
          {authedUser && (
            <li>
              <Link
                href="/profile"
                prefetch={false}
                aria-current={pathname === "/profile" ? "page" : undefined}
                className={ACCOUNT_MENU_ROW_CLASS}
              >
                Account
              </Link>
            </li>
          )}
          <li>
            <button
              type="button"
              data-close-menu
              onClick={() => openMyWeather()}
              className={ACCOUNT_MENU_ROW_CLASS}
            >
              My Weather
            </button>
          </li>
          <li>
            <button
              type="button"
              data-close-menu
              onClick={() => void handleMyLocation()}
              disabled={locating}
              aria-busy={locating}
              className={ACCOUNT_MENU_ROW_CLASS}
            >
              {locating && <Spinner className="h-4 w-4" />}
              Use my location
            </button>
          </li>
        </ul>
      </section>
      <section aria-labelledby={groupLabel("weather")}>
        <h2
          id={groupLabel("weather")}
          className="guineafowl-heading !px-[var(--inset-floor)] pt-2"
        >
          Weather
        </h2>
        <ul className="flex flex-col">
          <li>
            <Link
              href={weatherMapHref(mapSlug)}
              prefetch={false}
              aria-label={
                mapSlug
                  ? "Weather map"
                  : "Choose a location for the weather map"
              }
              className={ACCOUNT_MENU_ROW_CLASS}
            >
              Weather map
            </Link>
          </li>
          <li>
            {/* Opens the notifications centre (the alerts for your places and
                their settings) in a sheet, the same one the header's bell
                opens; the menu closes first, like My Weather. */}
            <button
              type="button"
              data-close-menu
              onClick={() => openNotifications()}
              aria-haspopup="dialog"
              className={ACCOUNT_MENU_ROW_CLASS}
            >
              {NOTIFICATIONS_LABEL}
            </button>
          </li>
        </ul>
      </section>
      <section aria-labelledby={groupLabel("pages")}>
        <h2
          id={groupLabel("pages")}
          className="guineafowl-heading !px-[var(--inset-floor)] pt-2"
        >
          Pages
        </h2>
        <ul className="flex flex-col">
          {destinations.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                prefetch={false}
                aria-current={
                  isDestinationActive(pathname, href) ? "page" : undefined
                }
                className={ACCOUNT_MENU_ROW_CLASS}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </AccountMenu>
  );
}
