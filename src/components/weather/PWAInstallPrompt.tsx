"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { trackEvent } from "@/lib/analytics";
import { requestInstall } from "@/lib/install-app";
import { useCanInstall } from "@/lib/use-install-app";
import { readStorage, removeStorage, writeStorage } from "@/lib/safe-storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Storage key to track dismissal — respects user choice */
const DISMISSED_KEY = "mukoko-pwa-install-dismissed";

/** Don't re-prompt for 30 days after dismissal */
const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Delay before showing the prompt — let the user experience the app first */
const SHOW_DELAY_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * PWA install prompt: a branded dialog offered a minute after the browser says
 * the app can be installed, never on load. Respects user dismissal (30-day
 * cooldown). The install itself is `requestInstall()` (src/lib/install-app.ts):
 * `navigator.install()` where the browser has it, else the captured
 * `beforeinstallprompt`. The same action is always on request in the profile
 * ("Install app"), so a dismissal is never a dead end.
 *
 * This does NOT show on iOS Safari (neither mechanism exists there). iOS users
 * get instructions in the Help/FAQ page instead.
 */
export function PWAInstallPrompt() {
  const [open, setOpen] = useState(false);
  // True once Install has been pressed: the dialog then closes without that
  // being recorded as a dismissal.
  const acted = useRef(false);
  const installButton = useRef<HTMLButtonElement | null>(null);
  // False when running as the installed app, or when the browser offers no way
  // to install (the dialog is never shown for something it cannot do).
  const available = useCanInstall();

  useEffect(() => {
    if (!available) return;

    // Check dismissal cooldown
    const dismissed = readStorage(DISMISSED_KEY);
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      if (
        !isNaN(dismissedAt) &&
        Date.now() - dismissedAt < DISMISS_COOLDOWN_MS
      ) {
        return;
      }
    }

    // Delay showing the prompt to let the user experience the app
    const timer = setTimeout(() => {
      acted.current = false;
      setOpen(true);
      trackEvent("modal_opened", { modal: "pwa_install" });
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [available]);

  const handleInstall = useCallback(async () => {
    // Called first, before anything is awaited: navigator.install() needs the
    // tap's transient user activation.
    const pending = requestInstall();
    acted.current = true;
    const outcome = await pending;
    if (outcome === "accepted" || outcome === "dismissed") {
      trackEvent("onboarding_completed", { method: `pwa_install_${outcome}` });
    }
    if (outcome === "accepted") {
      // User accepted — mark as installed
      removeStorage(DISMISSED_KEY);
    }
    setOpen(false);
  }, []);

  const handleDismiss = useCallback(() => {
    // Guard: once Install was pressed the dialog closes as a choice to install
    // (handleInstall closes it). Without this check, onOpenChange(false) would
    // incorrectly record a dismissal.
    if (acted.current) return;

    setOpen(false);

    // Record dismissal with timestamp for cooldown
    writeStorage(DISMISSED_KEY, String(Date.now()));

    trackEvent("onboarding_completed", { method: "pwa_install_dismissed" });
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleDismiss();
      }}
    >
      <DialogContent
        heading="Install mukoko weather"
        className="sm:max-w-sm"
        // The primary action is the point of this prompt: focus it, not the
        // Close in the shared bar (which every other dialog opens on).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          installButton.current?.focus();
        }}
      >
        <DialogHeader className="items-center gap-4 px-6 pt-3 text-center">
          {/* App icon — full-color brand mark */}
          <div className="flex items-center justify-center w-16 h-16 rounded-[var(--radius-card)] bg-surface-dim">
            <Image
              src="/favicon.svg"
              alt="mukoko weather"
              width={48}
              height={48}
              className="w-12 h-12"
            />
          </div>

          <DialogDescription className="text-sm text-text-secondary leading-relaxed">
            Get instant access from your home screen with offline weather data
            for your saved locations.
          </DialogDescription>
        </DialogHeader>

        {/* Feature highlights */}
        <ul className="space-y-3 px-6 py-2 text-sm text-text-secondary">
          {[
            "Works offline with cached weather data",
            "Faster loads — no browser overhead",
            "Full-screen experience on your device",
          ].map((highlight, index) => (
            <li key={highlight} className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-sm"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span>{highlight}</span>
            </li>
          ))}
        </ul>

        {/* Actions */}
        <div className="flex flex-col gap-2 px-6 pt-2 pb-6">
          <Button
            ref={installButton}
            onClick={handleInstall}
            className="min-h-[var(--touch-target-min)]"
          >
            Install app
          </Button>
          <Button
            onClick={handleDismiss}
            variant="ghost"
            className="min-h-[var(--touch-target-min)] text-text-tertiary hover:text-text-secondary"
          >
            Not now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
