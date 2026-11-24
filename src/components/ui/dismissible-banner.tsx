"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import {
  closeBanner,
  isBannerClosed,
  subscribeToBanners,
  type BannerMemory,
} from "@/lib/banner-dismissal";
import { cn } from "@/lib/utils";

interface Props {
  /**
   * Names the message. A banner closed under one id comes back under another,
   * so put what the message says in it (the risk, the reason).
   */
  id: string;
  /**
   * `visit`: closed until the page is reloaded. `session`: closed for the rest
   * of the tab's session, reloads included.
   */
  remember?: BannerMemory;
  /** What the close button says to a screen reader ("Dismiss frost warning"). */
  closeLabel: string;
  className?: string;
  /** The alert itself. Leave `pr-12` free on it: the close button sits there. */
  children: ReactNode;
}

/**
 * A banner a person can close: the alert (an `Alert`) on a solid card, so it
 * reads on the sky and on the page alike, with a close button at the top
 * right. The button is a full touch target (`--touch-target-min`).
 *
 * The server and the first client render show the banner (it may matter, and
 * the memory is not known there); a banner closed earlier is dropped as soon as
 * the client has read the memory. Nothing else changes size.
 */
export function DismissibleBanner({
  id,
  remember = "visit",
  closeLabel,
  className,
  children,
}: Props) {
  const isClosed = useSyncExternalStore(
    subscribeToBanners,
    () => isBannerClosed(id, remember),
    () => false,
  );
  if (isClosed) return null;
  return (
    <div
      data-banner={id}
      className={cn(
        "relative rounded-[var(--radius-card)] bg-surface-card shadow-sm",
        className,
      )}
    >
      {children}
      <button
        type="button"
        aria-label={closeLabel}
        onClick={() => closeBanner(id, remember)}
        className="absolute top-0 right-0 inline-flex min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] items-center justify-center rounded-full text-text-secondary transition-colors hover:text-text-primary"
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
