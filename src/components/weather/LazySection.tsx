"use client";

import { SectionSkeleton } from "@/components/weather/SectionSkeleton";
import {
  hasLayoutBox,
  loadMarginPx,
  maxConcurrentMounts,
  readDeviceHints,
  reservedHeightPx,
  settleDelayMs,
  shouldUnloadSection,
  unloadMarginPx,
} from "@/lib/lazy-visibility";
import { cn } from "@/lib/utils";
import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

interface LazySectionProps {
  children: ReactNode;
  /** Placeholder shown before the section enters the viewport */
  fallback?: ReactNode;
  /** IntersectionObserver rootMargin — how far before the viewport to start loading */
  rootMargin?: string;
  /** Debug label for console logging */
  label?: string;
  /** Optional class applied to the persistent wrapper div (e.g. grid column spans) */
  className?: string;
}

const DEFAULT_FALLBACK = <SectionSkeleton className="h-48" />;

// ── Bounded mount queue ─────────────────────────────────────────────────────
//
// Problem: When multiple IntersectionObservers fire simultaneously (user scrolls
// fast, or data appears on a page), all triggered sections try to mount at once.
// This causes a DOM/Canvas surge that can OOM-kill mobile browser tabs before
// any JS error handler fires.
//
// Solution: a global FIFO queue with a small number of mount slots (two on
// capable devices, one on constrained ones — see maxConcurrentMounts). Each
// mount holds its slot until the browser has painted it (rAF) plus a short
// settle delay, so heavy sections still arrive a frame or two apart instead
// of all in one task. The schedule (slots, delay, how far ahead to start)
// lives in src/lib/lazy-visibility.ts, where it is unit tested.

type QueueEntry = {
  mount: () => void;
  cancelled: boolean;
};

const mountQueue: QueueEntry[] = [];
let activeMounts = 0;

function processQueue(): void {
  const hints = readDeviceHints();
  const slots = maxConcurrentMounts(hints);
  while (activeMounts < slots && mountQueue.length > 0) {
    const next = mountQueue.shift()!;
    if (next.cancelled) continue;

    activeMounts += 1;
    next.mount();

    // Hold the slot until the mount has painted (rAF) and the device has had
    // a moment to settle, then release it and start the next one.
    requestAnimationFrame(() => {
      setTimeout(() => {
        activeMounts = Math.max(0, activeMounts - 1);
        processQueue();
      }, settleDelayMs(hints));
    });
  }
}

function enqueueMount(mountFn: () => void): () => void {
  const entry: QueueEntry = { mount: mountFn, cancelled: false };
  mountQueue.push(entry);
  processQueue();
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
// The unload margin is at least twice the load margin (and never under
// 1500px) to prevent flickering on normal scroll speed. A section must scroll well
// past the viewport before being reclaimed.
//
// Two further guards keep the mount/unmount cycle from feeding itself:
//
// - A section with no layout box (display: none, e.g. the .herd stack hiding
//   a card that rendered nothing) is never unmounted. IntersectionObserver
//   reports a box-less element as "not intersecting" wherever it is, which
//   used to unmount it, re-show the skeleton, remount it, hide it again —
//   a loop of several cycles a second (see shouldUnloadSection).
// - While unmounted, the wrapper keeps the height the content had, so the
//   shorter skeleton never shifts the sections below it.

/** Load margin for this device, as an IntersectionObserver rootMargin. */
function getLoadMargin(): string {
  return `${loadMarginPx(readDeviceHints())}px`;
}

/** Unload margin, always well beyond the load margin (see unloadMarginPx). */
function getUnloadMargin(loadMargin: string): string {
  const load = Number.parseFloat(loadMargin);
  return `${unloadMarginPx(Number.isFinite(load) ? load : 0)}px`;
}

/**
 * Progressive lazy section with TikTok-style sequential mounting.
 *
 * Key differences from a naive IntersectionObserver:
 * 1. **Bounded mounting** — at most two sections mount at once (one on
 *    constrained devices), through a global queue
 * 2. **Bidirectional** — sections unmount when far off-screen to reclaim memory
 * 3. **Adaptive timing** — starts 1.5 viewports ahead; constrained devices
 *    get one slot, a smaller margin and a longer settle delay
 * 4. **Canvas-optimised** — Chart.js instances are destroyed on unmount automatically
 */
export function LazySection({
  children,
  fallback = DEFAULT_FALLBACK,
  rootMargin,
  label = "unknown",
  className,
}: LazySectionProps) {
  const loadMargin = rootMargin ?? getLoadMargin();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  // True while unmounted with the content's last measured height reserved
  // on the wrapper (via the --lazy-reserved-height custom property).
  const [reserved, setReserved] = useState(false);

  // Start invisible unless IntersectionObserver is unavailable
  const [visible, setVisible] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof IntersectionObserver === "undefined",
  );

  // Track if the section has ever been mounted (for unload observer)
  const hasRendered = useRef(false);
  // Whether to play entrance animation — true only on the initial mount.
  // Bidirectional remounts (section scrolled off-screen then back) skip the
  // animation to avoid a visual stutter when content reappears.
  const [animate, setAnimate] = useState(false);

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
            setAnimate(!hasRendered.current);
            setReserved(false);
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
        // it's far enough off-screen to reclaim — unless it has no layout
        // box at all, which reads as "not intersecting" from anywhere.
        if (
          shouldUnloadSection({
            isIntersecting: entry.isIntersecting,
            hasLayoutBox: hasLayoutBox(el),
          })
        ) {
          const height = reservedHeightPx(entry.boundingClientRect.height);
          if (height !== null) {
            el.style.setProperty("--lazy-reserved-height", `${height}px`);
            setReserved(true);
          }
          setVisible(false);
        }
      },
      { rootMargin: getUnloadMargin(loadMargin) },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, loadMargin]);

  // Maintain a persistent ref div that the observer can track even after unmount
  return (
    <div
      ref={sentinelRef}
      data-lazy-section={label}
      className={cn(
        className,
        !visible && reserved && "min-h-[var(--lazy-reserved-height)]",
      )}
    >
      {visible ? (
        <div className={animate ? "animate-fade-in-up" : undefined}>
          {children}
        </div>
      ) : (
        fallback
      )}
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
