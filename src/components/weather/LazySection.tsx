"use client";

import { useRef, useState, useEffect, type ReactNode } from "react";

interface LazySectionProps {
  children: ReactNode;
  /** Placeholder shown before the section enters the viewport */
  fallback?: ReactNode;
  /** IntersectionObserver rootMargin — how far before the viewport to start loading */
  rootMargin?: string;
}

const DEFAULT_FALLBACK = (
  <div className="h-48 animate-pulse rounded-[var(--radius-card)] bg-surface-card" />
);

/**
 * Defer rendering of heavy content until it scrolls near the viewport.
 *
 * Uses IntersectionObserver to detect when a sentinel element is within
 * `rootMargin` of the viewport, then swaps the placeholder for the real
 * children. This prevents all chart components from mounting simultaneously,
 * which causes OOM tab-kills on mobile devices.
 */
export function LazySection({ children, fallback = DEFAULT_FALLBACK, rootMargin = "300px" }: LazySectionProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(
    () => typeof window !== "undefined" && typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (visible) return;
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, rootMargin]);

  if (!visible) {
    return <div ref={sentinelRef}>{fallback}</div>;
  }

  return <>{children}</>;
}
