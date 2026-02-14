"use client";

import { useRef, useState, useEffect, type ReactNode } from "react";

interface LazySectionProps {
  children: ReactNode;
  /** Placeholder shown before the section enters the viewport */
  fallback?: ReactNode;
  /** IntersectionObserver rootMargin — how far before the viewport to start loading */
  rootMargin?: string;
  /** Debug label for console logging */
  label?: string;
}

const DEFAULT_FALLBACK = (
  <div className="h-48 animate-pulse rounded-[var(--radius-card)] bg-surface-card" />
);

// ── Mobile mount queue ───────────────────────────────────────────────────────
// On mobile, multiple IntersectionObservers can fire simultaneously when the
// user scrolls (or when data appears on the history page). If all triggered
// sections mount at once, the cumulative SVG/DOM weight from Recharts charts
// causes OOM tab-kills — the OS kills the browser tab before any JS error
// handler can fire, so React error boundaries never catch it.
//
// The queue ensures only ONE section mounts per animation frame, giving the
// browser time to layout, paint, and GC between each heavy render.
// On desktop (>= 768px), sections mount immediately with no queueing.

type MountFn = () => void;
const pendingMounts: MountFn[] = [];
let processing = false;

function processQueue(): void {
  if (pendingMounts.length === 0) {
    processing = false;
    return;
  }
  processing = true;
  const next = pendingMounts.shift()!;
  next();
  // rAF waits for the browser to finish layout + paint, then a short timeout
  // gives the GC headroom on memory-constrained mobile devices before the
  // next heavy component mounts.
  requestAnimationFrame(() => {
    setTimeout(processQueue, 100);
  });
}

function enqueueMount(fn: MountFn): () => void {
  pendingMounts.push(fn);
  if (!processing) processQueue();
  // Return cleanup: removes from queue if the component unmounts before
  // the queue gets to it (e.g. user navigates away mid-scroll).
  return () => {
    const i = pendingMounts.indexOf(fn);
    if (i !== -1) pendingMounts.splice(i, 1);
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Use a smaller trigger distance on mobile to avoid mounting too many
// heavy components at once (Recharts SVG, ReactMarkdown, etc.).
function getDefaultRootMargin(): string {
  if (typeof window === "undefined") return "300px";
  return window.innerWidth < 768 ? "100px" : "300px";
}

/**
 * Defer rendering of heavy content until it scrolls near the viewport.
 *
 * Uses IntersectionObserver to detect when a sentinel element is within
 * `rootMargin` of the viewport, then swaps the placeholder for the real
 * children. On mobile, mounts are staggered through a global queue so
 * only one heavy section renders per animation frame — preventing the
 * simultaneous SVG/DOM surge that causes OOM tab-kills.
 */
export function LazySection({ children, fallback = DEFAULT_FALLBACK, rootMargin, label = "unknown" }: LazySectionProps) {
  const resolvedMargin = rootMargin ?? getDefaultRootMargin();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [visible, setVisible] = useState(
    () => typeof window !== "undefined" && typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (visible) return;
    const el = sentinelRef.current;
    if (!el) return;

    const mobile = typeof window !== "undefined" && window.innerWidth < 768;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          if (mobile) {
            // Queue the mount — only one section renders per frame on mobile
            cleanupRef.current = enqueueMount(() => setVisible(true));
          } else {
            setVisible(true);
          }
        }
      },
      { rootMargin: resolvedMargin },
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      // Clean up queued mount if component unmounts before being processed
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [visible, resolvedMargin, label]);

  if (!visible) {
    return <div ref={sentinelRef}>{fallback}</div>;
  }

  return <>{children}</>;
}
