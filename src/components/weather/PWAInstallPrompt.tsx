"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types for the beforeinstallprompt event (not in lib.dom.d.ts)
// ---------------------------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key to track dismissal — respects user choice */
const DISMISSED_KEY = "mukoko-pwa-install-dismissed";

/** Don't re-prompt for 30 days after dismissal */
const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Delay before showing the prompt — let the user experience the app first */
const SHOW_DELAY_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * PWA install prompt — shows a branded dialog when the browser fires
 * `beforeinstallprompt`. Respects user dismissal (30-day cooldown).
 *
 * This does NOT show on iOS Safari (which doesn't fire beforeinstallprompt).
 * iOS users get instructions in the Help/FAQ page instead.
 */
export function PWAInstallPrompt() {
  const [open, setOpen] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Already installed as PWA — don't show
    if (typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches) {
      return;
    }

    // Check dismissal cooldown
    if (typeof localStorage !== "undefined") {
      const dismissed = localStorage.getItem(DISMISSED_KEY);
      if (dismissed) {
        const dismissedAt = parseInt(dismissed, 10);
        if (!isNaN(dismissedAt) && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) {
          return;
        }
      }
    }

    const handler = (e: Event) => {
      // Prevent Chrome's default mini-infobar
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;

      // Delay showing the prompt to let the user experience the app
      timerRef.current = setTimeout(() => {
        setOpen(true);
        trackEvent("modal_opened", { modal: "pwa_install" });
      }, SHOW_DELAY_MS);
    };

    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt.current) return;

    try {
      await deferredPrompt.current.prompt();
      const { outcome } = await deferredPrompt.current.userChoice;
      trackEvent("onboarding_completed", { method: `pwa_install_${outcome}` });

      if (outcome === "accepted") {
        // User accepted — mark as installed
        if (typeof localStorage !== "undefined") {
          localStorage.removeItem(DISMISSED_KEY);
        }
      }
    } catch {
      // prompt() can throw if already called or dismissed
    }

    deferredPrompt.current = null;
    setOpen(false);
  }, []);

  const handleDismiss = useCallback(() => {
    // Guard: if deferredPrompt is already null, the user accepted the install
    // (handleInstall nulls the ref before closing the dialog). Without this
    // check, onOpenChange(false) would incorrectly record a dismissal.
    if (!deferredPrompt.current) return;

    setOpen(false);
    deferredPrompt.current = null;

    // Record dismissal with timestamp for cooldown
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    }

    trackEvent("onboarding_completed", { method: "pwa_install_dismissed" });
  }, []);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleDismiss(); }}>
      <DialogContent className="max-w-sm rounded-2xl p-6 sm:p-6">
        <DialogHeader className="items-center text-center gap-4">
          {/* App icon — full-color brand mark */}
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-dim">
            <Image
              src="/icons/icon.svg"
              alt="mukoko weather"
              width={48}
              height={48}
              className="w-12 h-12"
            />
          </div>

          <DialogTitle className="text-xl font-bold text-text-primary">
            Install mukoko weather
          </DialogTitle>

          <DialogDescription className="text-sm text-text-secondary leading-relaxed">
            Get instant access from your home screen with offline weather data for your saved locations.
          </DialogDescription>
        </DialogHeader>

        {/* Feature highlights */}
        <ul className="space-y-3 py-2 text-sm text-text-secondary">
          <li className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs" aria-hidden="true">1</span>
            <span>Works offline with cached weather data</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs" aria-hidden="true">2</span>
            <span>Faster loads — no browser overhead</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs" aria-hidden="true">3</span>
            <span>Full-screen experience on your device</span>
          </li>
        </ul>

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-2">
          <Button
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
