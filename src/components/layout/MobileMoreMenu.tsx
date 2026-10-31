"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Ellipsis } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useAppStore } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { trackEvent } from "@/lib/analytics";
import type { PublicUser } from "@/lib/user-display";
import {
  currentLocationSlug,
  isLocationSlug,
  CURRENT_LOCATION_EVENT,
  writeLastLocationCookie,
} from "@/lib/current-slug";

/** One row of the mobile ⋯ menu — full 48px touch height. */
const MENU_ITEM_CLASS =
  "flex min-h-[var(--touch-target-min)] w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 text-left text-base font-semibold text-text-primary transition-colors hover:bg-surface-dim aria-[current=page]:text-primary";

interface Props {
  /** Class of the round ⋯ trigger (`bee` in the header pill, `kestrel-round`
   *  in the hero's top row). */
  buttonClassName: string;
  /** Class of the ellipsis glyph (colour on its surface). */
  iconClassName?: string;
}

/**
 * The phone ⋯ menu — Explore, History, Aviation, My Weather, Use my location
 * and the account. One component, two homes: the header's action pill, and the
 * hero's top row on place pages, where the phone header is not drawn (the sky
 * runs to the top of the screen). Disclosure pattern: `aria-expanded` /
 * `aria-controls`, closes on activation, outside click or Escape (focus returns
 * to the trigger). The panel opens under the trigger; the caller supplies the
 * `relative` wrapper.
 */
export function MobileMoreMenu({ buttonClassName, iconClassName }: Props) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const authedUser = user as PublicUser | null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const isExplore = pathname === "/explore" || pathname.startsWith("/explore/");
  const isHistory = pathname === "/history";
  const isAviation = pathname === "/aviation";
  const shamwariEnabled = isFeatureEnabled("shamwari_chat");

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [menuOpen]);

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

  return (
    <div ref={menuRef}>
      <button
        ref={menuButtonRef}
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="More options"
        aria-expanded={menuOpen}
        aria-controls="mobile-more-menu"
        className={buttonClassName}
        type="button"
      >
        <Ellipsis size={20} className={iconClassName} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div
          id="mobile-more-menu"
          className="absolute right-0 top-full z-40 mt-2 w-56 rounded-[var(--radius-card)] border border-text-tertiary/10 bg-surface-card p-2 text-left text-text-primary"
        >
          <ul className="flex flex-col">
            <li>
              <Link
                href="/explore"
                prefetch={false}
                aria-current={isExplore ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
                className={MENU_ITEM_CLASS}
              >
                Explore
              </Link>
            </li>
            {shamwariEnabled && (
              <li>
                <Link
                  href="/shamwari"
                  prefetch={false}
                  aria-current={pathname === "/shamwari" ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={MENU_ITEM_CLASS}
                >
                  Shamwari
                </Link>
              </li>
            )}
            <li>
              <Link
                href="/history"
                prefetch={false}
                aria-current={isHistory ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
                className={MENU_ITEM_CLASS}
              >
                History
              </Link>
            </li>
            <li>
              <Link
                href="/aviation"
                prefetch={false}
                aria-current={isAviation ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
                className={MENU_ITEM_CLASS}
              >
                Aviation
              </Link>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  openMyWeather();
                }}
                className={MENU_ITEM_CLASS}
              >
                My Weather
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void handleMyLocation();
                }}
                disabled={locating}
                aria-busy={locating}
                className={MENU_ITEM_CLASS}
              >
                {locating && <Spinner className="h-4 w-4" />}
                Use my location
              </button>
            </li>
            <li>
              <Link
                href={authedUser ? "/profile" : "/auth/signin"}
                prefetch={false}
                onClick={() => setMenuOpen(false)}
                className={MENU_ITEM_CLASS}
              >
                {authedUser ? "Account" : "Sign in"}
              </Link>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
