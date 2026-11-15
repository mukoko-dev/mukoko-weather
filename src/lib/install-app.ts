/**
 * Installing the app from the page, in the browser's own consent UI.
 *
 * Follows the modern-web-guidance `install-web-app` guide:
 *
 * - `navigator.install()` (the Web Install API) when the browser has it. It
 *   must be called straight from the click handler: a call that waits first
 *   has lost the user's transient activation and rejects with
 *   `NotAllowedError`.
 * - Otherwise the `beforeinstallprompt` event, captured with its automatic
 *   prompt prevented. The event is single-use, so it is dropped before the
 *   person's answer is awaited.
 * - Neither: `canInstall()` is false, so no control is offered. A button that
 *   does nothing is worse than none, and the browser's own menu still works.
 *
 * Nothing here ever prompts. `requestInstall()` is only called from a tap.
 * The manifest declares an explicit `id` (public/manifest.json), which the
 * no-argument `navigator.install()` requires.
 *
 * State is held at module level because `beforeinstallprompt` fires once,
 * early, and the control that wants it (the profile row) mounts later than the
 * component that is always mounted (`PWAInstallPrompt`).
 */

import { isStandalone } from "@/lib/device-info";

export type InstallOutcome =
  | "accepted"
  | "dismissed"
  | "unavailable"
  | "failed";

/** The `beforeinstallprompt` event (not in lib.dom.d.ts). */
interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let busy = false;
let wired = false;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/** True when the browser has the Web Install API. */
export function supportsWebInstall(): boolean {
  return (
    typeof Navigator !== "undefined" &&
    typeof (Navigator.prototype as { install?: unknown }).install === "function"
  );
}

/** True when an install can be started now, and the app is not already one. */
export function canInstall(): boolean {
  if (typeof window === "undefined" || installed) return false;
  if (isStandalone(window)) return false;
  return supportsWebInstall() || deferred !== null;
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    // No mini-infobar: the install control is the page's, shown on request.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

wire();

/** For `useSyncExternalStore`. Returns the unsubscribe. */
export function subscribeInstall(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Start the install. Call it directly from a click handler, with nothing
 * awaited before it. Resolves with what the person chose; never throws.
 */
export async function requestInstall(): Promise<InstallOutcome> {
  if (busy) return "unavailable";
  busy = true;
  try {
    if (supportsWebInstall()) {
      // First statement of the handler's call chain: keeps the activation.
      await (navigator as unknown as { install(): Promise<unknown> }).install();
      return "accepted";
    }
    const prompt = deferred;
    if (!prompt) return "unavailable";
    // Single-use: drop it before awaiting the person's answer.
    deferred = null;
    emit();
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    return outcome;
  } catch (error) {
    // Cancelling is a choice, not a failure; keep the control to try again.
    if ((error as { name?: string } | null)?.name === "AbortError") {
      return "dismissed";
    }
    return "failed";
  } finally {
    busy = false;
  }
}

/** Tests only: a fresh page. */
export function _resetInstallState(): void {
  deferred = null;
  installed = false;
  busy = false;
  listeners.clear();
}
