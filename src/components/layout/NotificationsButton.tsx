"use client";

import { lazy, Suspense, useRef } from "react";
import { BellIcon } from "@/lib/weather-icons";
import { NotificationsBoundary } from "@/components/notifications/NotificationsBoundary";
import { NOTIFICATIONS_LABEL } from "@/lib/header-nav";
import { useAppStore } from "@/lib/store";
import { useAlertBadge } from "@/lib/use-alerts";

// The notifications centre (the alerts list and its settings) loads when it
// is first opened, so none of it is in a page's first-load JavaScript.
const NotificationsCentre = lazy(() =>
  import("@/components/notifications/NotificationsCentre").then((m) => ({
    default: m.NotificationsCentre,
  })),
);

/** The accessible name: the count is in the name, never the dot alone. */
export function notificationsName(alertCount: number): string {
  return alertCount > 0
    ? `${NOTIFICATIONS_LABEL}, ${alertCount} ${alertCount === 1 ? "alert" : "alerts"}`
    : NOTIFICATIONS_LABEL;
}

/**
 * Notifications, the second control of the Quick actions group: the bell, the
 * dot that says there is something to read, and the notifications centre it
 * opens (alerts for your places and their settings). The ONE place the centre
 * is mounted: the open state is the store's global `notificationsOpen`, so
 * every other way in (the phone menu's row, My Weather, the profile page)
 * opens this same instance, and a second mount anywhere would open two. The
 * group is mounted once for the whole app (see QuickActions), so this is too.
 *
 * The centre hangs under the wrapper (`anchorRef`) from `sm` up and is a
 * bottom sheet on phones.
 */
export function NotificationsButton() {
  const notificationsOpen = useAppStore((s) => s.notificationsOpen);
  const openNotifications = useAppStore((s) => s.openNotifications);
  const closeNotifications = useAppStore((s) => s.closeNotifications);
  const alertCount = useAlertBadge();
  // The bell's wrapper: the centre's popover hangs under it.
  const anchorRef = useRef<HTMLDivElement>(null);
  const name = notificationsName(alertCount);

  return (
    <div className="relative" ref={anchorRef}>
      <button
        onClick={() =>
          notificationsOpen ? closeNotifications() : openNotifications("list")
        }
        data-notifications-trigger
        aria-label={name}
        title={NOTIFICATIONS_LABEL}
        aria-haspopup="dialog"
        aria-expanded={notificationsOpen}
        className="bee relative"
        type="button"
      >
        <BellIcon size={20} />
        {alertCount > 0 && (
          <span
            aria-hidden="true"
            data-alert-dot
            className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full"
          />
        )}
      </button>
      {notificationsOpen && (
        <NotificationsBoundary onClose={closeNotifications}>
          <Suspense>
            <NotificationsCentre anchorRef={anchorRef} />
          </Suspense>
        </NotificationsBoundary>
      )}
    </div>
  );
}
