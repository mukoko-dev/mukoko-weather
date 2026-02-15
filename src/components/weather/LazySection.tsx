"use client";

import { useRef, useState, useEffect, useCallback, type ReactNode } from "react";

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

// ── TikTok-style sequential mount queue ─────────────────────────────────────
//
// Problem: When multiple IntersectionObservers fire simultaneously (user scrolls
// fast, or data appears on a page), all triggered sections try to mount at once.
// This causes a DOM/Canvas surge that can OOM-kill mobile browser tabs before
// any JS error handler fires.
//
// Solution: A global FIFO queue that mounts ONE component at a time. Each mount
// is separated by a paint frame (rAF) + a configurable settle delay, giving the
// browser time to layout, paint, and GC before the next heavy component appears.
//
// This mirrors how TikTok/Instagram handle infinite scroll: only the visible
// item gets "active" treatment, everything else is deferred.
//
// On desktop (>= 768px), sections ALSO go through the queue but with a shorter
// settle delay (50ms vs 150ms on mobile), since desktop has more headroom.

type QueueEntry = {
  mount: () => void;
  cancelled: boolean;
};

const mountQueue: QueueEntry[] = [];
let isProcessing = false;

function getSettleDelay(): number {
  if (typeof window === "undefined") return 100;
  return window.innerWidth < 768 ? 150 : 50;
}

function processQueue(): void {
  // Find the next non-cancelled entry
  while (mountQueue.length > 0) {
    const next = mountQueue.shift()!;
    if (next.cancelled) continue;

    isProcessing = true;
    next.mount();

    // Wait for paint + settle before mounting the next section.
    // rAF ensures the browser has painted the current mount.
    // setTimeout gives the GC headroom on memory-constrained devices.
    requestAnimationFrame(() => {
      setTimeout(() => {
        isProcessing = false;
        processQueue();
      }, getSettleDelay());
    });
    return;
  }
  isProcessing = false;
}

function enqueueMount(mountFn: () => void): () => void {
  const entry: QueueEntry = { mount: mountFn, cancelled: false };
  mountQueue.push(entry);
  if (!isProcessing) processQueue();
  return () => {
    entry.cancelled = true;
  };
}

// ── Bidirectional visibility (TikTok-style unmount off-screen) ──────────────
//
// Unlike the old LazySection which kept components mounted forever after first
// render, this version monitors visibility in BOTH directions:
//
// 1. Component enters viewport → mount (via queue)
// 2. Component scrolls FAR out of viewport → unmount to reclaim memory
//
// This caps peak memory regardless of how many sections exist on the page.
// At any time, only ~2-3 sections near the viewport are fully rendered.
// The rest show a lightweight placeholder.
//
// The unload margin is much larger than the load margin (1500px vs 300px)
// to prevent flickering on normal scroll speed. A section must scroll well
// past the viewport before being reclaimed.

const UNLOAD_MARGIN = "1500px";

function getLoadMargin(): string {
  if (typeof window === "undefined") return "300px";
  return window.innerWidth < 768 ? "100px" : "300px";
}

/**
 * Progressive lazy section with TikTok-style sequential mounting.
 *
 * Key differences from a naive IntersectionObserver:
 * 1. **Sequential mounting** — only ONE section mounts at a time (global queue)
 * 2. **Bidirectional** — sections unmount when far off-screen to reclaim memory
 * 3. **Adaptive timing** — mobile gets longer settle delays than desktop
 * 4. **Canvas-optimised** — Chart.js instances are destroyed on unmount automatically
 */
export function LazySection({
  children,
  fallback = DEFAULT_FALLBACK,
  rootMargin,
  label = "unknown",
}: LazySectionProps) {
  const loadMargin = rootMargin ?? getLoadMargin();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  // Start invisible unless IntersectionObserver is unavailable
  const [visible, setVisible] = useState(
    () => typeof window !== "undefined" && typeof IntersectionObserver === "undefined",
  );

  // Track if the section has ever been mounted (for unload observer)
  const hasRendered = useRef(false);

  // ── Load observer: mount when entering viewport ───────────────────────
  useEffect(() => {
    if (visible) return;
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          cancelRef.current = enqueueMount(() => {
            setVisible(true);
            hasRendered.current = true;
          });
        }
      },
      { rootMargin: loadMargin },
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [visible, loadMargin]);

  // ── Unload observer: unmount when far off-screen ──────────────────────
  useEffect(() => {
    if (!visible || !hasRendered.current) return;
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // When the element is NOT intersecting with the extended margin,
        // it's far enough off-screen to reclaim.
        if (!entry.isIntersecting) {
          setVisible(false);
        }
      },
      { rootMargin: UNLOAD_MARGIN },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // Maintain a persistent ref div that the observer can track even after unmount
  const content = visible ? children : fallback;

  return (
    <div ref={sentinelRef} data-lazy-section={label}>
      {content}
    </div>
  );
}

// ── Memory pressure monitor ─────────────────────────────────────────────────
// Detects when the JS heap is under pressure and triggers aggressive cleanup.
// Uses Performance.memory (Chrome/Edge) where available.

export function useMemoryPressure(thresholdMB: number = 150): boolean {
  const [underPressure, setUnderPressure] = useState(false);

  const check = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perf = performance as any;
    if (perf.memory) {
      const usedMB = perf.memory.usedJSHeapSize / (1024 * 1024);
      setUnderPressure(usedMB > thresholdMB);
    }
  }, [thresholdMB]);

  useEffect(() => {
    // Defer initial check to avoid sync setState in effect body
    const initial = setTimeout(check, 0);
    const id = setInterval(check, 5000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [check]);

  return underPressure;
}
