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

/**
 * Defer rendering of heavy content until it scrolls near the viewport.
 *
 * Uses IntersectionObserver to detect when a sentinel element is within
 * `rootMargin` of the viewport, then swaps the placeholder for the real
 * children. This prevents all chart components from mounting simultaneously,
 * which causes OOM tab-kills on mobile devices.
 */
// Use a smaller trigger distance on mobile to avoid mounting too many
// heavy components at once (Recharts SVG, ReactMarkdown, etc.).
function getDefaultRootMargin(): string {
  if (typeof window === "undefined") return "300px";
  return window.innerWidth < 768 ? "100px" : "300px";
}

export function LazySection({ children, fallback = DEFAULT_FALLBACK, rootMargin, label = "unknown" }: LazySectionProps) {
  const resolvedMargin = rootMargin ?? getDefaultRootMargin();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(
    () => typeof window !== "undefined" && typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (visible) return;
    const el = sentinelRef.current;
    if (!el) {
      console.warn("[LazySection]", label, "— no sentinel ref");
      return;
    }

    console.log("[LazySection]", label, "— observing (margin:", resolvedMargin, ")");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          console.log("[LazySection]", label, "— VISIBLE, mounting children");
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: resolvedMargin },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, resolvedMargin, label]);

  if (!visible) {
    return <div ref={sentinelRef}>{fallback}</div>;
  }

  return <>{children}</>;
}
