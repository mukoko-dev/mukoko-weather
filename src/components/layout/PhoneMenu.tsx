"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Ellipsis } from "lucide-react";
import {
  ACCOUNT_MENU_ROW_CLASS,
  AccountMenu,
} from "@/components/ui/app-account-menu";
import { Spinner } from "@/components/ui/spinner";
import { useAppStore } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { trackEvent } from "@/lib/analytics";
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
  NOTIFICATIONS_EMPTY_TEXT,
  isDestinationActive,
  visibleHeaderDestinations,
  weatherMapHref,
} from "@/lib/header-nav";

interface Props {
  /**
   * The trigger: `profile` is the hero's top-row control (the Mzizi account
   * avatar: photo or initials when signed in, the user icon otherwise),
   * `ellipsis` the ⋯ in the header's action pill.
   */
  trigger: "profile" | "ellipsis";
  /** Class of the round trigger (`kestrel-round` in the hero, `bee` in the header pill). */
  buttonClassName: string;
  /** Class of the ⋯ glyph (colour on its surface). */
  iconClassName?: string;
}

/**
 * The ONE phone menu: a thin wrapper around the Mzizi `app-account-menu`
 * (`src/components/ui/app-account-menu.tsx`). The registry component owns the
 * disclosure, the identity header and the sign-out form; this file only fills
 * its slot with the rows the site header carries — My Weather, Use my
 * location, the weather map, notifications and the header's destinations
 * (`HEADER_DESTINATIONS`) — and wires them to the app's store and routes, so
 * nothing is lost where the phone header is not drawn (over the sky hero). One
 * wrapper, two homes: the hero's top row (profile trigger) and the header's
 * action pill (⋯ trigger).
 */
export function PhoneMenu({ trigger, buttonClassName, iconClassName }: Props) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const authedUser = user as PublicUser | null;
  const [locating, setLocating] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsId = useId();
  const groupId = useId();

  const destinations = visibleHeaderDestinations(isFeatureEnabled);
  const mapSlug = currentLocationSlug(pathname, selectedLocation);

  // Find where the user is right now (same GPS -> /api/py/geo flow as My
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
        if (pathname === "/") {
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
      trigger={
        trigger === "ellipsis" ? (
          <Ellipsis size={20} className={iconClassName} aria-hidden="true" />
        ) : undefined
      }
      triggerLabel={
        trigger === "ellipsis"
          ? "More options"
          : authedUser
            ? `Account menu for ${displayNameFor(authedUser)}`
            : "Account menu"
      }
      onOpenChange={(open) => {
        if (!open) setNotificationsOpen(false);
      }}
    >
      <section aria-labelledby={groupLabel("account")}>
        <h2 id={groupLabel("account")} className="guineafowl-heading !px-3">
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
          className="guineafowl-heading !px-3 pt-2"
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
            <button
              type="button"
              onClick={() => setNotificationsOpen((v) => !v)}
              aria-expanded={notificationsOpen}
              aria-controls={notificationsId}
              className={ACCOUNT_MENU_ROW_CLASS}
            >
              Notifications
            </button>
            {notificationsOpen && (
              <p
                id={notificationsId}
                className="dove px-3 pb-2"
                aria-live="polite"
              >
                {NOTIFICATIONS_EMPTY_TEXT}
              </p>
            )}
          </li>
        </ul>
      </section>
      <section aria-labelledby={groupLabel("pages")}>
        <h2 id={groupLabel("pages")} className="guineafowl-heading !px-3 pt-2">
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
