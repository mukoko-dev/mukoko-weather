"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { DetailSheet } from "@/components/ui/detail-sheet";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getReportTypeInfo } from "@/lib/report-types";
import { loadReports } from "@/lib/reports-api";
import { canonicalSlug } from "@/lib/slug-migration";
import { trackEvent } from "@/lib/analytics";
import { useAppStore } from "@/lib/store";
import { useAlertSnapshot } from "@/lib/use-alerts";
import { useDevicePush } from "@/lib/use-device-push";
import { PHONE_QUERY, useMediaQuery } from "@/lib/use-media-query";
import { currentLocationSlug } from "@/lib/current-slug";
import { NOTIFICATIONS_LABEL } from "@/lib/header-nav";
import { usePathname } from "next/navigation";
import { NotificationSettingsView } from "./NotificationSettings";
import {
  NotificationsPanelView,
  type ReportableKind,
} from "./NotificationsPanel";

/** Marks the bell; the centre gives focus back to it when the opener is gone. */
export const NOTIFICATIONS_TRIGGER_ATTR = "data-notifications-trigger";

const NOTIFICATIONS_TITLE = NOTIFICATIONS_LABEL;
const SETTINGS_TITLE = "Notification settings";

/** The report buttons this build can offer (type known, reporting on). */
export function offeredReportKinds(
  reportsOn: boolean,
  hasType: (id: string) => boolean,
): ReportableKind[] {
  if (!reportsOn) return [];
  return (["flooding", "wildfire"] as const).filter((kind) => hasType(kind));
}

function isVisible(el: Element | null): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.isConnected &&
    el.getClientRects().length > 0
  );
}

/**
 * Where focus goes when the centre closes: the control that opened it if it
 * is still on screen (a menu row is not: its menu closed), else the bell, else
 * the account menu's trigger. Evaluated when the sheet closes.
 */
function focusTargetFor(opener: Element | null): HTMLElement | null {
  // The page itself is no opener: when the control that was focused is
  // hidden by the time the centre mounts (a menu row whose menu just closed),
  // the browser reports the body as focused.
  if (
    isVisible(opener) &&
    opener !== document.body &&
    !opener.closest("[data-slot='account-menu-panel']")
  ) {
    return opener;
  }
  // The first one on screen: the header's bell is not drawn over the sky hero
  // on a phone, where the account menu is the bottom bar's first slot.
  const firstVisible = (selector: string): HTMLElement | null =>
    [...document.querySelectorAll(selector)].find(isVisible) ?? null;
  return (
    firstVisible(`[${NOTIFICATIONS_TRIGGER_ATTR}]`) ??
    firstVisible("[data-slot='account-menu'] summary")
  );
}

/**
 * The notifications centre. ONE component with two containers around the same
 * contents: a bottom sheet on phones (the shared `DetailSheet`) and a popover
 * under the bell from `sm` up. The settings always open in the sheet (a form
 * needs room, and they can be opened from anywhere: the profile, My Weather).
 *
 * Mounted only while open (the header renders it behind `notificationsOpen`),
 * and loaded on demand, so the alerts code is never in a page's first-load
 * JavaScript.
 */
export function NotificationsCentre({
  anchorRef,
}: {
  /** The bell's wrapper: the popover hangs under it and ignores clicks on it. */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const view = useAppStore((s) => s.notificationsView);
  const open = useAppStore((s) => s.notificationsOpen);
  const openNotifications = useAppStore((s) => s.openNotifications);
  const closeNotifications = useAppStore((s) => s.closeNotifications);
  const openReportModal = useAppStore((s) => s.openReportModal);
  const prefs = useAppStore((s) => s.notificationPrefs);
  const setPrefs = useAppStore((s) => s.setNotificationPrefs);
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const pathname = usePathname();
  const phone = useMediaQuery(PHONE_QUERY);

  const snapshot = useAlertSnapshot(open);
  const push = useDevicePush();

  // The control that opened the centre (read once, at mount). Where focus goes
  // back to is decided when the sheet closes, because a menu row is gone by
  // then (`focusTargetFor`).
  const [opener] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );
  useEffect(() => {
    trackEvent("modal_opened", { modal: "notifications" });
  }, []);

  const placeOnScreen = currentLocationSlug(pathname, selectedLocation);
  // Opening the centre is the person asking: read the community reports for
  // the place on screen, so a report is not missed just because its card has
  // not scrolled near yet. ONE read, through the shared store (the report lane
  // and the recent-reports card make the same call, so it is deduped and kept
  // for a minute); never one per saved place. When it settles the watch
  // notices and the list updates.
  useEffect(() => {
    if (!placeOnScreen) return;
    // Under the canonical slug, the key the report lane and the card use.
    loadReports(canonicalSlug(placeOnScreen)).catch(() => {
      // Supplementary: the list simply has no community alerts then.
    });
  }, [placeOnScreen]);
  const reportKinds = offeredReportKinds(
    isFeatureEnabled("weather_reports"),
    (id) => getReportTypeInfo(id) !== undefined,
  );

  const report = useCallback(
    (kind: ReportableKind, placeSlug: string | null) => {
      // The wizard is a dialog of its own: close this one first so two never
      // stack, then open it on the type, for the alert's place.
      trackEvent("alert_report_started", { kind });
      closeNotifications();
      openReportModal({
        reportType: kind,
        ...(placeSlug ? { locationSlug: placeSlug } : {}),
      });
    },
    [closeNotifications, openReportModal],
  );

  if (!open) return null;

  const settings = view === "settings";
  const body = settings ? (
    <NotificationSettingsView
      prefs={prefs}
      onChange={setPrefs}
      push={push}
      onBack={() => openNotifications("list")}
    />
  ) : (
    <NotificationsPanelView
      snapshot={snapshot}
      reportKinds={reportKinds}
      reportPlace={placeOnScreen}
      onReport={report}
      onOpenSettings={() => openNotifications("settings")}
    />
  );

  if (settings || phone) {
    return (
      <DetailSheet
        open
        title={settings ? SETTINGS_TITLE : NOTIFICATIONS_TITLE}
        onClose={closeNotifications}
        returnFocusTo={() => focusTargetFor(opener)}
      >
        {body}
      </DetailSheet>
    );
  }
  return (
    <NotificationsPopover anchorRef={anchorRef} onClose={closeNotifications}>
      {body}
    </NotificationsPopover>
  );
}

/**
 * The desktop container: a non-modal dialog under the bell. Escape closes it
 * and returns focus to the bell, a press outside closes it, and so does
 * moving focus out of it (Tab), as the account menu does. Pointer events, not
 * mouse events: iOS sends no mouse events for a tap on a non-clickable element.
 */
function NotificationsPopover({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
    const inside = (node: EventTarget | null) =>
      node instanceof Node &&
      (panelRef.current?.contains(node) || anchorRef.current?.contains(node));
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      anchorRef.current
        ?.querySelector<HTMLElement>(`[${NOTIFICATIONS_TRIGGER_ATTR}]`)
        ?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={NOTIFICATIONS_TITLE}
      tabIndex={-1}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (
          next instanceof Node &&
          !panelRef.current?.contains(next) &&
          !anchorRef.current?.contains(next)
        ) {
          onClose();
        }
      }}
      className="absolute right-0 top-full z-40 mt-2 max-h-[calc(100dvh-6rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface-card p-[var(--inset-floor)] text-left shadow-lg outline-none"
    >
      <h2 className="giraffe mb-[var(--space-stack)]">{NOTIFICATIONS_TITLE}</h2>
      {children}
    </div>
  );
}
