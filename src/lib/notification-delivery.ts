/**
 * The "Delivery" part of the notification settings, as data
 * (mukoko-dev/mukoko-weather#289). Pure: the browser facts come in as
 * arguments (`PushEnv`, from `push/client.ts`), nothing is read here.
 *
 * Three ways an alert could reach a person:
 *
 * - **In the app**: always on. Alerts are worked out on the device from the
 *   forecasts it holds, so this needs no server and cannot be switched off.
 * - **Push on this device**: wired to `push/client.ts`, with an honest state
 *   for every case (below). The row offers a button only when it can do
 *   something. While the alert service is not live (`serverReady` false, the
 *   `web_push` flag), the row says "Not switched on yet" and has no button:
 *   we never show a switch that does nothing.
 * - **Campfire** (Mukoko's own messaging, end to end encrypted; owner,
 *   2026-11-05: we build our own, not Telegram): "Coming soon", no button
 *   and no backend in this version.
 *
 * Delivery is best effort and never described as guaranteed.
 */

import {
  pushState,
  type EnableResult,
  type PushEnv,
  type PushState,
} from "./push/client";

export const DELIVERY_BEST_EFFORT = "Delivery is best effort.";

export const IN_APP_DELIVERY = {
  title: "In the app",
  status: "Always on",
  detail:
    "Alerts are worked out on this device from the forecasts it holds, so they can be late or missed. Delivery is best effort.",
} as const;

/** The messaging channels that are not built yet. */
export const COMING_SOON_CHANNELS = [
  {
    id: "campfire",
    title: "Campfire",
    detail: "Alerts in Mukoko's own messaging app.",
  },
] as const;

export type PushRowStatus =
  | "checking" // the browser has not been asked yet (first render)
  | "unsupported" // this browser cannot receive push
  | "needs-install" // iOS Safari tab: add to the Home Screen first
  | "denied" // the browser blocks notifications for this site
  | "not-switched-on" // the alert service is not live yet
  | "available" // can be switched on
  | "enabled" // switched on for this device
  | "error"; // the last attempt failed

export interface PushRow {
  status: PushRowStatus;
  title: "Push on this device";
  /** The short state word on the right ("Not switched on yet", "On"). */
  state: string;
  /** One or two plain sentences saying what is true and what to do. */
  detail: string;
  /** The one button the row offers, or null when it can do nothing. */
  action: "enable" | "disable" | null;
  actionLabel: string | null;
}

export interface PushRowInput {
  /** The browser's facts, or null before they were read (server render, first paint). */
  env: PushEnv | null;
  /** The alert service is live: the push routes and the VAPID key exist (`FLAGS.web_push`). */
  serverReady: boolean;
  /** This browser holds a push subscription for the app. */
  subscribed: boolean;
  /** The result of the last switch on, switch off or check. */
  lastResult?: EnableResult | "disabled" | "not-subscribed" | null;
}

const TITLE = "Push on this device" as const;

function row(
  status: PushRowStatus,
  state: string,
  detail: string,
  action: PushRow["action"] = null,
  actionLabel: string | null = null,
): PushRow {
  return { status, title: TITLE, state, detail, action, actionLabel };
}

/**
 * The state of the push row. Device facts come first (a browser that cannot do
 * push cannot, whatever the server does), then whether the service is live,
 * then whether this browser is switched on.
 */
export function pushRow(input: PushRowInput): PushRow {
  const { env, serverReady, subscribed, lastResult } = input;
  if (!env) {
    return row("checking", "Checking", "Checking what this device supports.");
  }

  const state: PushState = pushState(env);
  if (state === "needs-install") {
    return row(
      "needs-install",
      "Add to Home Screen first",
      "On iPhone and iPad, push works only for an app added to the Home Screen. Open the Share menu, choose Add to Home Screen, then open mukoko weather from there.",
    );
  }
  if (state === "unsupported") {
    return row(
      "unsupported",
      "Not supported here",
      "This browser cannot receive push messages. Alerts still appear in the app.",
    );
  }
  if (state === "denied") {
    return row(
      "denied",
      "Blocked",
      "Notifications are blocked for this site. Allow them in your browser's site settings, then come back.",
    );
  }
  if (!serverReady) {
    return row(
      "not-switched-on",
      "Not switched on yet",
      "We cannot send push messages until the alert service is live. Alerts still appear in the app.",
    );
  }
  if (subscribed && state === "granted") {
    return row(
      "enabled",
      "On",
      `Alerts can reach this device when the app is closed. ${DELIVERY_BEST_EFFORT}`,
      "disable",
      "Switch off push",
    );
  }
  if (lastResult === "error") {
    return row(
      "error",
      "Could not switch on",
      "Something went wrong switching push on. Try again in a moment.",
      "enable",
      "Try again",
    );
  }
  const note =
    lastResult === "dismissed"
      ? "You closed the permission prompt, so nothing changed. "
      : "";
  return row(
    "available",
    "Off",
    `${note}Get an alert on this device when the app is closed. ${DELIVERY_BEST_EFFORT}`,
    "enable",
    "Switch on push",
  );
}

/** What to record in the device's permission memory after an attempt. */
export function permissionToRecord(
  result: EnableResult,
): "granted" | "denied" | "dismissed" | null {
  switch (result) {
    case "enabled":
      return "granted";
    case "denied":
      return "denied";
    case "dismissed":
      return "dismissed";
    default:
      return null;
  }
}
