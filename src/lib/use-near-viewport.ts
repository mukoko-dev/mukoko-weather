"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Pure part of useNearViewport: whether an IntersectionObserver entry means
 * "close enough to start the work". Kept separate so it is unit tested.
 */
export function isNearViewport(entry: { isIntersecting: boolean }): boolean {
  return entry.isIntersecting;
}

/**
 * True once the element has come within `rootMargin` of the viewport, and
 * from then on (it never flips back). Used to hold back fetches for content
 * below the fold until the reader is heading there, so they do not compete
 * with the first render.
 *
 * Without IntersectionObserver (very old browsers) it is true at once, so
 * nothing is ever withheld.
 */
export function useNearViewport(
  ref: RefObject<Element | null>,
  rootMargin = "800px",
  enabled = true,
): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!enabled || near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      const id = requestAnimationFrame(() => setNear(true));
      return () => cancelAnimationFrame(id);
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && isNearViewport(entry)) {
          observer.disconnect();
          setNear(true);
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin, enabled, near]);
  return near;
}
