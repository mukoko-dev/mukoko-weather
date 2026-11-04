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
 *
 * `resetKey` starts over when it changes (the observed content is for a new
 * place), so a component that stays mounted behaves like a fresh mount.
 */
export function useNearViewport(
  ref: RefObject<Element | null>,
  rootMargin = "800px",
  enabled = true,
  resetKey?: string,
): boolean {
  const [nearFor, setNearFor] = useState<string | undefined | null>(null);
  const near = nearFor !== null && nearFor === resetKey;
  const setNear = () => setNearFor(resetKey);
  useEffect(() => {
    if (!enabled || near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      const id = requestAnimationFrame(() => setNear());
      return () => cancelAnimationFrame(id);
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && isNearViewport(entry)) {
          observer.disconnect();
          setNear();
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, rootMargin, enabled, near, resetKey]);
  return near;
}
