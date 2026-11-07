/**
 * The notifications centre rendered for real (react-dom/server): the alerts
 * list, the settings, the switch row and the container. The views are
 * store-free and hook-free, so a click is tested by walking the element tree
 * and calling the handler a button carries.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ tracked: [] as unknown[][] }));
vi.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => events.tracked.push(args),
}));

const store = vi.hoisted(() => ({
  notificationsOpen: true,
  notificationsView: "list" as "list" | "settings",
  notificationPrefs: {
    frost: true,
    lightning: true,
    wildfire: true,
    flooding: true,
    quietStart: null as number | null,
    quietEnd: null as number | null,
  },
  selectedLocation: "harare",
  openNotifications: vi.fn(),
  closeNotifications: vi.fn(),
  openReportModal: vi.fn(),
  setNotificationPrefs: vi.fn(),
}));
vi.mock("@/lib/store", () => ({
  useAppStore: (select: (s: typeof store) => unknown) => select(store),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/harare" }));

import type { Alert } from "@/lib/alerts";
import type { AlertSnapshot } from "@/lib/alerts-watch";
import { pushRow } from "@/lib/notification-delivery";
import { DEFAULT_NOTIFICATION_PREFS } from "@/lib/notification-prefs";
import type { PushEnv } from "@/lib/push/client";
import { ToggleRow } from "@/components/weather/ToggleRow";
import {
  NOTIFICATIONS_TRIGGER_ATTR,
  NotificationsCentre,
  offeredReportKinds,
} from "./NotificationsCentre";
import { NotificationsBoundary } from "./NotificationsBoundary";
import { NotificationSettingsView } from "./NotificationSettings";
import { NotificationsPanelView } from "./NotificationsPanel";

const read = (file: string) => readFileSync(resolve(__dirname, file), "utf-8");

// --- element tree helpers --------------------------------------------------

type El = ReactElement<{ children?: ReactNode } & Record<string, unknown>>;

/** Every element in the tree, expanding hook-free function components. */
function walk(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out));
  } else if (isValidElement(node)) {
    const el = node as El;
    if (typeof el.type === "function") {
      walk((el.type as (p: unknown) => ReactNode)(el.props), out);
    } else {
      out.push(el);
      walk(el.props.children, out);
    }
  }
  return out;
}

const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join("")
    : isValidElement(node)
      ? textOf((node as El).props.children)
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : "";

function buttons(node: ReactNode): El[] {
  return walk(node).filter((e) => e.type === "button");
}

// --- fixtures --------------------------------------------------------------

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: "harare:frost:advisory",
  kind: "frost",
  level: "advisory",
  severity: "high",
  placeSlug: "harare",
  placeName: "Harare",
  headline: "Frost advisory",
  message:
    "Frost is likely, with a low near 1°C. Cover seedlings and sensitive plants.",
  when: "Tonight, between 22:00 and 06:00",
  asOf: "Forecast as of 15:55 (Harare time)",
  asOfMs: 0,
  source: "From the forecast, not an official warning",
  ...over,
});

const snapshotWith = (
  shown: Alert[],
  extra: Partial<AlertSnapshot["result"]> = {},
  all: Alert[] = shown,
): AlertSnapshot => ({
  result: {
    alerts: all,
    placesChecked: 2,
    placesTotal: 3,
    forecastUpdatedAt: Date.parse("2026-07-10T13:50:00Z"),
    ...extra,
  },
  shown,
  quiet: false,
  at: Date.parse("2026-07-10T14:05:00Z"),
});

const panel = (
  over: Partial<Parameters<typeof NotificationsPanelView>[0]> = {},
) =>
  NotificationsPanelView({
    snapshot: snapshotWith([]),
    reportKinds: ["flooding", "wildfire"],
    reportPlace: "harare",
    onReport: vi.fn(),
    onOpenSettings: vi.fn(),
    ...over,
  });

const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement);

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: "default",
  isIos: false,
  isStandalone: false,
  ...over,
});

const settings = (
  over: Partial<Parameters<typeof NotificationSettingsView>[0]> = {},
) =>
  NotificationSettingsView({
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    onChange: vi.fn(),
    push: {
      row: pushRow({ env: env(), serverReady: false, subscribed: false }),
      busy: false,
      onAction: vi.fn(),
    },
    ...over,
  });

beforeEach(() => {
  events.tracked.length = 0;
  store.notificationsOpen = true;
  store.notificationsView = "list";
  store.openNotifications.mockClear();
  store.closeNotifications.mockClear();
  store.openReportModal.mockClear();
  store.setNotificationPrefs.mockClear();
});

// ---------------------------------------------------------------------------

describe("ToggleRow", () => {
  const row = (checked: boolean, over = {}) =>
    html(
      ToggleRow({
        id: "alert-frost",
        label: "Frost",
        description: "A cold night.",
        checked,
        onChange: () => undefined,
        ...over,
      }),
    );

  it("is a switch whose state is announced and never colour alone", () => {
    const on = row(true);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain(">On<");
    const off = row(false);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain(">Off<");
  });

  it("is described by its explanation and named by its label", () => {
    const out = row(true);
    expect(out).toContain('aria-describedby="alert-frost-about"');
    expect(out).toContain('id="alert-frost-about"');
    expect(out).toContain("Frost");
    expect(row(true, { description: undefined })).not.toContain(
      "aria-describedby",
    );
  });

  it("flips on a click and honours disabled", () => {
    const onChange = vi.fn();
    const el = walk(
      ToggleRow({ id: "a", label: "A", checked: false, onChange }),
    ).find((e) => e.type === "button")!;
    (el.props.onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith(true);
    expect(row(true, { disabled: true })).toContain("disabled");
  });

  it("is a 49px row from the shared surface, with the 14px inset and no hardcoded style", () => {
    const src = read("../weather/ToggleRow.tsx");
    expect(row(true)).toContain("bushbuck");
    expect(src).toContain("px-[var(--inset-floor)]");
    expect(src).not.toMatch(/style=|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(src).not.toContain("text-xs");
  });
});

describe("NotificationsPanelView: the list", () => {
  it("says it is checking before the first read", () => {
    const out = html(panel({ snapshot: null }));
    expect(out).toContain("Checking your places…");
    expect(out).toContain('role="status"');
  });

  it("opens with what the alerts are and are not, and that delivery is best effort", () => {
    const out = html(panel());
    expect(out).toContain("not official warnings");
    expect(out).toContain("Delivery is best effort.");
  });

  it("announces changes politely and never steals focus", () => {
    const out = html(panel({ snapshot: snapshotWith([alert()]) }));
    expect(out).toContain('aria-live="polite"');
    expect(out).not.toContain("autofocus");
  });

  it("shows each alert with its kind, place, when, as-of and source", () => {
    const out = html(panel({ snapshot: snapshotWith([alert()]) }));
    expect(out).toContain('aria-label="Alerts for your places"');
    expect(out).toContain("<article");
    expect(out).toContain("Frost advisory");
    expect(out).toContain("Harare");
    expect(out).toContain("Frost is likely, with a low near 1°C.");
    expect(out).toContain("Tonight, between 22:00 and 06:00");
    expect(out).toContain("Forecast as of 15:55 (Harare time)");
    expect(out).toContain("From the forecast, not an official warning");
  });

  it("labels each card by its heading", () => {
    const out = html(panel({ snapshot: snapshotWith([alert()]) }));
    expect(out).toMatch(
      /<article aria-labelledby="alert-harare-frost-advisory"/,
    );
    expect(out).toContain('<h3 id="alert-harare-frost-advisory"');
  });

  it("offers Report flooding on a flooding alert and Report wildfire on a wildfire alert, for THAT place", () => {
    const flood = alert({
      id: "mutare:flooding:advisory",
      kind: "flooding",
      placeSlug: "mutare",
      placeName: "Mutare",
      headline: "Flood advisory",
    });
    const fire = alert({
      id: "gweru:wildfire:community",
      kind: "wildfire",
      level: "community",
      placeSlug: "gweru",
      placeName: "Gweru",
      headline: "Community report: wildfire",
      source: "Community report, unverified",
    });
    const onReport = vi.fn();
    const tree = panel({ snapshot: snapshotWith([flood, fire]), onReport });
    const labels = buttons(tree).map((b) => textOf(b));
    expect(labels).toEqual([
      "Report flooding",
      "Report wildfire",
      "Alert settings",
    ]);
    const [reportFlood, reportFire] = buttons(tree);
    (reportFlood.props.onClick as () => void)();
    (reportFire.props.onClick as () => void)();
    expect(onReport).toHaveBeenNthCalledWith(1, "flooding", "mutare");
    expect(onReport).toHaveBeenNthCalledWith(2, "wildfire", "gweru");
  });

  it("offers no report button on frost or lightning", () => {
    const tree = panel({
      snapshot: snapshotWith([
        alert(),
        alert({ id: "harare:lightning:advisory", kind: "lightning" }),
      ]),
    });
    expect(buttons(tree).map((b) => textOf(b))).toEqual(["Alert settings"]);
  });

  it("hides a report button for a type this build does not know", () => {
    const fire = alert({
      id: "gweru:wildfire:community",
      kind: "wildfire",
      level: "community",
    });
    const tree = panel({
      snapshot: snapshotWith([fire]),
      reportKinds: ["flooding"],
    });
    expect(buttons(tree).map((b) => textOf(b))).toEqual(["Alert settings"]);
    const empty = panel({ reportKinds: ["flooding"] });
    expect(buttons(empty).map((b) => textOf(b))).toEqual([
      "Report flooding",
      "Alert settings",
    ]);
  });

  it("opens the settings", () => {
    const onOpenSettings = vi.fn();
    const tree = panel({ onOpenSettings });
    const settingsButton = buttons(tree).find(
      (b) => textOf(b) === "Alert settings",
    )!;
    (settingsButton.props.onClick as () => void)();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationsPanelView: the empty state", () => {
  it("is honest and useful: what was checked, when, and how to report", () => {
    const out = html(panel());
    expect(out).toContain("No alerts for your places right now");
    expect(out).toMatch(
      /Checked 2 places, with forecasts last updated at \d\d:\d\d\./,
    );
    expect(out).toContain("Report flooding");
    expect(out).toContain("Report wildfire");
    expect(out).toContain("Alert settings");
  });

  it("does not say there are no alerts when nothing was checked", () => {
    const out = html(
      panel({
        snapshot: snapshotWith([], {
          placesChecked: 0,
          forecastUpdatedAt: null,
        }),
      }),
    );
    expect(out).toContain("Nothing to check yet");
    expect(out).not.toContain("No alerts for your places");
  });

  it("says when alerts are hidden because a kind is off", () => {
    const hidden = snapshotWith([], {}, [alert()]);
    expect(html(panel({ snapshot: hidden }))).toContain(
      "1 alert is hidden because you switched that kind off.",
    );
  });

  it("offers no report buttons without a place to report for", () => {
    const tree = panel({ reportPlace: null });
    expect(buttons(tree).map((b) => textOf(b))).toEqual(["Alert settings"]);
    expect(html(tree)).not.toContain("Seeing something?");
  });

  it("the report buttons carry the place on screen", () => {
    const onReport = vi.fn();
    const tree = panel({ onReport, reportKinds: ["wildfire"] });
    (buttons(tree)[0].props.onClick as () => void)();
    expect(onReport).toHaveBeenCalledWith("wildfire", "harare");
  });
});

describe("NotificationSettingsView", () => {
  it("lists the four kinds, named exactly, as switches in the owner's order", () => {
    const tree = settings();
    const switches = walk(tree).filter((e) => e.props.role === "switch");
    const names = switches
      .filter((e) => String(e.props.id).startsWith("alert-kind-"))
      .map((e) => textOf(e.props.children).slice(0, 12));
    expect(names).toEqual([
      expect.stringMatching(/^Frost/),
      expect.stringMatching(/^Lightning/),
      expect.stringMatching(/^Wildfire/),
      expect.stringMatching(/^Flooding/),
    ]);
    const out = html(tree);
    for (const label of ["Frost", "Lightning", "Wildfire", "Flooding"]) {
      expect(out).toContain(`>${label}<`);
    }
  });

  it("reflects the person's choices", () => {
    const out = html(
      settings({
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, lightning: false },
      }),
    );
    expect(out).toMatch(/id="alert-kind-lightning"[^>]*aria-checked="false"/);
    expect(out).toMatch(/id="alert-kind-frost"[^>]*aria-checked="true"/);
  });

  it("switches a kind and records the choice", () => {
    const onChange = vi.fn();
    const tree = settings({ onChange });
    const frost = walk(tree).find((e) => e.props.id === "alert-kind-frost")!;
    (frost.props.onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith({ frost: false });
    expect(events.tracked).toContainEqual([
      "alert_kind_toggled",
      { kind: "frost", enabled: false },
    ]);
  });

  it("wildfire says it is community reports only", () => {
    const out = html(settings());
    expect(out).toContain("Community reports only");
    expect(out).toContain("no forecast or satellite wildfire alert yet");
  });

  it("quiet hours are off by default, with no pickers", () => {
    const out = html(settings());
    expect(out).toMatch(/id="quiet-hours"[^>]*aria-checked="false"/);
    expect(out).not.toContain('id="quiet-from"');
    expect(out).toContain("On this device\u2019s clock");
  });

  it("switching quiet hours on gives the Night preset; the pickers then show 24 hours each", () => {
    const onChange = vi.fn();
    const quiet = walk(settings({ onChange })).find(
      (e) => e.props.id === "quiet-hours",
    )!;
    (quiet.props.onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith({ quietStart: 22, quietEnd: 6 });

    const on = html(
      settings({
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, quietStart: 22, quietEnd: 6 },
      }),
    );
    expect(on).toContain('id="quiet-from"');
    expect(on).toContain('id="quiet-to"');
    expect(on).toContain('for="quiet-from"');
    expect(on.match(/<option /g)).toHaveLength(48);
    expect(on).toMatch(/<option value="22" selected/);
    expect(on).toMatch(/<option value="6" selected/);
  });

  it("picking an hour never leaves two equal ends", () => {
    const onChange = vi.fn();
    const tree = settings({
      onChange,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS, quietStart: 22, quietEnd: 6 },
    });
    const from = walk(tree).find((e) => e.props.id === "quiet-from")!;
    (from.props.onChange as (e: unknown) => void)({ target: { value: "6" } });
    expect(onChange).toHaveBeenCalledWith({ quietStart: 6, quietEnd: 7 });
  });

  it("delivery: in the app is always on and delivery is best effort", () => {
    const out = html(settings());
    expect(out).toContain("In the app");
    expect(out).toContain("Always on");
    expect(out).toContain("Delivery is best effort.");
    expect(out).toContain("An alert can arrive late or not at all.");
  });

  it("delivery: push says Not switched on yet and has no button while the service is not live", () => {
    const out = html(settings());
    expect(out).toContain("Push on this device");
    expect(out).toContain("Not switched on yet");
    const pushCard = walk(settings()).find(
      (e) => e.props["data-delivery-status"] === "not-switched-on",
    )!;
    expect(buttons(pushCard.props.children)).toEqual([]);
  });

  it("delivery: push shows its one button only when it can act, wired to the action", () => {
    const onAction = vi.fn();
    const live = settings({
      push: {
        row: pushRow({ env: env(), serverReady: true, subscribed: false }),
        busy: false,
        onAction,
      },
    });
    const card = walk(live).find(
      (e) => e.props["data-delivery-status"] === "available",
    )!;
    const [button] = buttons(card.props.children);
    expect(textOf(button)).toBe("Switch on push");
    expect(button.props.className).toBe("kudu-sm");
    (button.props.onClick as () => void)();
    expect(onAction).toHaveBeenCalledTimes(1);

    const busy = settings({
      push: {
        row: pushRow({ env: env(), serverReady: true, subscribed: false }),
        busy: true,
        onAction,
      },
    });
    const [working] = buttons(
      walk(busy).find((e) => e.props["data-delivery-status"] === "available")!
        .props.children,
    );
    expect(textOf(working)).toBe("Working…");
    expect(working.props.disabled).toBe(true);
  });

  it("delivery: each honest state has its words and no button", () => {
    const cases: Array<[PushEnv, string]> = [
      [env({ hasPushManager: false }), "This browser cannot receive push"],
      [env({ isIos: true }), "Add to Home Screen"],
      [env({ permission: "denied" }), "Notifications are blocked"],
    ];
    for (const [e, text] of cases) {
      const tree = settings({
        push: {
          row: pushRow({ env: e, serverReady: true, subscribed: false }),
          busy: false,
          onAction: vi.fn(),
        },
      });
      expect(html(tree)).toContain(text);
      const card = walk(tree).find(
        (x) => x.props["data-delivery-status"] !== undefined,
      )!;
      expect(buttons(card.props.children)).toEqual([]);
    }
  });

  it("delivery: Campfire is a Coming soon row with no control, and Telegram is not offered", () => {
    const tree = settings();
    const out = html(tree);
    expect(out).toContain("Campfire");
    expect(out).not.toMatch(/telegram/i);
    expect(out.match(/Coming soon/g)).toHaveLength(1);
    // The only buttons in the whole settings view are the ones above: no
    // control carries the channel's name.
    for (const b of buttons(tree)) {
      expect(textOf(b)).not.toMatch(/campfire/i);
    }
    for (const li of walk(tree).filter((e) => e.type === "li")) {
      if (/Campfire/.test(textOf(li))) {
        expect(buttons(li.props.children)).toEqual([]);
      }
    }
  });

  it("offers Back to alerts only when it was opened from the list", () => {
    expect(html(settings())).not.toContain("Back to alerts");
    const onBack = vi.fn();
    const tree = settings({ onBack });
    const back = buttons(tree).find((b) => textOf(b) === "Back to alerts")!;
    (back.props.onClick as () => void)();
    expect(onBack).toHaveBeenCalled();
  });

  it("says the choices are saved on this device", () => {
    expect(html(settings())).toContain(
      "Your choices are saved on this device.",
    );
  });

  it("labels each section by its heading and every select by a label", () => {
    const out = html(
      settings({
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, quietStart: 22, quietEnd: 6 },
      }),
    );
    for (const id of [
      "ns-alerts-heading",
      "ns-quiet-heading",
      "ns-delivery-heading",
    ]) {
      expect(out).toContain(`aria-labelledby="${id}"`);
      expect(out).toContain(`id="${id}"`);
    }
  });
});

describe("the Bundu floor and the style rules, for every notifications file", () => {
  const files = [
    "NotificationsPanel.tsx",
    "NotificationSettings.tsx",
    "NotificationsCentre.tsx",
  ];

  it("uses no hardcoded colour, inline style or px size", () => {
    for (const file of files) {
      const src = read(file);
      expect(src, file).not.toMatch(/style=\{|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
      expect(src, file).not.toMatch(/\b(w|h|p[xy]?|m[xy]?)-\[\d+px\]/);
    }
  });

  it("keeps text at 14px or larger (no text-xs, no caption size)", () => {
    for (const file of [...files, "../weather/ToggleRow.tsx"]) {
      expect(read(file), file).not.toMatch(
        /\btext-xs\b|text-\[(?:1[0-3]|[0-9])px\]|\boribi\b|text-caption/,
      );
    }
  });

  it("makes every button a shared pill control (49px tall)", () => {
    for (const file of files) {
      const chunks = read(file).split("<button").slice(1);
      for (const chunk of chunks) {
        const button = chunk.slice(0, chunk.indexOf("</button>"));
        expect(button, file).toMatch(/impala-sm|kudu-sm/);
      }
    }
  });

  it("does not use a weather-value colour or a mineral for an alert", () => {
    for (const file of files) {
      expect(read(file), file).not.toMatch(/mineral-|severity-|--wx-|--chart-/);
    }
  });

  it("uses the shared 7px gap and the page rhythm tokens", () => {
    expect(read("NotificationsPanel.tsx")).toContain("var(--gap-floor)");
    expect(read("NotificationSettings.tsx")).toContain("var(--gap-floor)");
    expect(read("NotificationSettings.tsx")).toContain("var(--space-section)");
    expect(read("NotificationsCentre.tsx")).toContain("var(--inset-floor)");
  });
});

describe("NotificationsCentre: the container", () => {
  it("offers a report button only for a type the build knows, while reporting is on", () => {
    const has = (known: string[]) => (id: string) => known.includes(id);
    expect(offeredReportKinds(true, has(["flooding"]))).toEqual(["flooding"]);
    expect(offeredReportKinds(true, has(["flooding", "wildfire"]))).toEqual([
      "flooding",
      "wildfire",
    ]);
    expect(offeredReportKinds(true, has([]))).toEqual([]);
    expect(offeredReportKinds(false, has(["flooding", "wildfire"]))).toEqual(
      [],
    );
  });

  it("builds against the real report types: flooding exists today, wildfire only once added", async () => {
    const { getReportTypeInfo } = await import("@/lib/report-types");
    const kinds = offeredReportKinds(
      true,
      (id) => getReportTypeInfo(id) !== undefined,
    );
    expect(kinds).toContain("flooding");
    // Wildfire follows the Workers' allowlist (report-types.test.ts pins the
    // two lists together): the button appears when the type does.
    expect(kinds.includes("wildfire")).toBe(
      getReportTypeInfo("wildfire") !== undefined,
    );
  });

  it("renders the popover under the bell on a wide screen: a labelled non-modal dialog on the card surface", () => {
    const out = html(
      createElement(NotificationsCentre, { anchorRef: { current: null } }),
    );
    // Hooks run in the server render (effects do not): the list is checking.
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-label="Notifications"');
    expect(out).toContain('tabindex="-1"');
    expect(out).toContain("<h2");
    expect(out).toContain("bg-surface-card");
    expect(out).toContain("absolute right-0 top-full");
    expect(out).toContain("Checking your places…");
  });

  it("renders nothing when closed", () => {
    store.notificationsOpen = false;
    expect(
      html(
        createElement(NotificationsCentre, { anchorRef: { current: null } }),
      ),
    ).toBe("");
  });

  it("settings and the phone use the shared DetailSheet; the popover is for the list on a wide screen", () => {
    const src = read("NotificationsCentre.tsx");
    expect(src).toContain('from "@/components/ui/detail-sheet"');
    expect(src).toContain("if (settings || phone)");
    expect(src).toContain(
      "title={settings ? SETTINGS_TITLE : NOTIFICATIONS_TITLE}",
    );
    expect(src).toContain("returnFocusTo={() => focusTargetFor(opener)}");
    // One body, two containers: the contents are built once.
    expect(src.match(/<NotificationsPanelView/g)).toHaveLength(1);
    expect(src.match(/<NotificationSettingsView/g)).toHaveLength(1);
  });

  it("a report closes the centre first, then opens the wizard on the type and the alert's place", () => {
    const src = read("NotificationsCentre.tsx");
    const close = src.indexOf("closeNotifications();\n      openReportModal({");
    expect(close).toBeGreaterThan(-1);
    expect(src).toContain("reportType: kind,");
    expect(src).toContain("locationSlug: placeSlug");
    expect(src).toContain('trackEvent("alert_report_started", { kind })');
  });

  it("gives focus back to the opener, the bell or the account menu, and marks the bell", () => {
    const src = read("NotificationsCentre.tsx");
    expect(NOTIFICATIONS_TRIGGER_ATTR).toBe("data-notifications-trigger");
    expect(src).toContain("function focusTargetFor(");
    expect(src).toContain("[data-slot='account-menu'] summary");
    expect(src).toContain(
      "opener.closest(\"[data-slot='account-menu-panel']\")",
    );
  });

  it("closes the popover on Escape, an outside press and focus leaving it", () => {
    const src = read("NotificationsCentre.tsx");
    expect(src).toContain('e.key !== "Escape"');
    expect(src).toContain('document.addEventListener("pointerdown"');
    expect(src).toContain("onBlur={(e) => {");
    expect(src).toContain("panelRef.current?.focus()");
  });

  it("reads the community reports for the place on screen when it opens, once, never per saved place", () => {
    const src = read("NotificationsCentre.tsx");
    expect(src.match(/loadReports\(/g)).toHaveLength(1);
    expect(src).toContain("loadReports(canonicalSlug(placeOnScreen))");
    // Through the shared store: no hand-rolled fetch, no loop over places.
    expect(src).not.toMatch(/\bfetch\(|fetchWorker|postWorker/);
    expect(src).not.toMatch(/savedLocations/);
  });

  it("never gives focus back to the page body (what the browser reports once a menu row is hidden)", () => {
    expect(read("NotificationsCentre.tsx")).toContain(
      "opener !== document.body",
    );
  });

  it("looks for the first visible bell or account trigger to give focus back to", () => {
    const src = read("NotificationsCentre.tsx");
    expect(src).toContain("document.querySelectorAll(selector)");
    expect(src).toContain("firstVisible(`[${NOTIFICATIONS_TRIGGER_ATTR}]`)");
  });

  it("records that it opened", () => {
    expect(read("NotificationsCentre.tsx")).toContain(
      'trackEvent("modal_opened", { modal: "notifications" })',
    );
  });
});

describe("NotificationsBoundary", () => {
  it("renders its children while nothing fails", () => {
    expect(
      html(
        createElement(
          NotificationsBoundary,
          // `children` is passed as createElement's own argument (the lint
          // rule), so the props object is cast: it lacks only `children`.
          { onClose: () => undefined } as never,
          createElement("p", null, "centre"),
        ),
      ),
    ).toBe("<p>centre</p>");
  });

  it("falls back to a labelled alert with a way out once something threw", () => {
    const boundary = new NotificationsBoundary({
      onClose: vi.fn(),
      children: null,
    });
    boundary.state = NotificationsBoundary.getDerivedStateFromError();
    const out = html(boundary.render());
    expect(out).toContain('role="alert"');
    expect(out).toContain("Notifications could not load.");
    expect(out).toContain("impala-sm");
    expect(out).toContain(">Close<");
  });

  it("Close calls the store's close", () => {
    const onClose = vi.fn();
    const boundary = new NotificationsBoundary({ onClose, children: null });
    boundary.state = { failed: true };
    const close = buttons(boundary.render() as ReactNode)[0];
    (close.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
