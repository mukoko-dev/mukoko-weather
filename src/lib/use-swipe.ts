"use client";

import { useEffect, useMemo, useRef } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

/**
 * Horizontal swipe detection for touch screens.
 *
 * `useSwipe` returns touch handlers to spread onto a container. A swipe fires
 * only when the gesture is long enough and clearly horizontal, and it is
 * ignored when it starts inside an element that already scrolls sideways
 * (the hourly strip, the data tables) or inside `[data-no-swipe]`.
 */

/** Minimum horizontal travel, in CSS pixels, before a gesture counts. */
export const SWIPE_MIN_DISTANCE_PX = 60;

/** The horizontal travel must exceed this multiple of the vertical travel. */
export const SWIPE_DOMINANCE_RATIO = 1.5;

export type SwipeDirection = "left" | "right";

/**
 * Classify a finished gesture from its total displacement. Returns null for
 * short, diagonal, or vertical gestures. A left swipe (finger moves toward the
 * left edge) has negative `dx`.
 */
export function classifySwipe(
  dx: number,
  dy: number,
  threshold: number = SWIPE_MIN_DISTANCE_PX,
): SwipeDirection | null {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < threshold) return null;
  if (!(absX > SWIPE_DOMINANCE_RATIO * absY)) return null;
  return dx < 0 ? "left" : "right";
}

/** Attribute that opts a subtree out of swipe handling. */
export const NO_SWIPE_ATTRIBUTE = "data-no-swipe";

/**
 * True when a gesture that starts at `start` must not be treated as a swipe:
 * the start is inside `[data-no-swipe]`, or inside an element that scrolls
 * sideways (`overflow-x` auto/scroll with content wider than the box). The walk
 * stops at `root`, the element the handlers are attached to, so the page's own
 * `overflow-x-hidden` never excludes it.
 */
export function isSwipeExcluded(
  start: EventTarget | null,
  root: Element | null,
): boolean {
  let el: Element | null = isElement(start) ? start : null;
  while (el && el !== root) {
    if (el.hasAttribute(NO_SWIPE_ATTRIBUTE)) return true;
    if (isHorizontalScroller(el)) return true;
    el = el.parentElement;
  }
  return false;
}

/** `Element` does not exist outside the browser (SSR, Node tests). */
function isElement(value: EventTarget | null): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function isHorizontalScroller(el: Element): boolean {
  if (typeof window === "undefined") return false;
  if (el.scrollWidth <= el.clientWidth) return false;
  const overflowX = window.getComputedStyle(el).overflowX;
  return overflowX === "auto" || overflowX === "scroll";
}

interface UseSwipeOptions {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  enabled?: boolean;
}

interface SwipeStart {
  x: number;
  y: number;
}

/**
 * Touch handlers for a horizontal swipe. Callbacks are read through a ref, so
 * passing fresh closures each render is cheap and never re-binds the handlers.
 * Multi-touch gestures (pinch) are ignored.
 */
export function useSwipe({
  onSwipeLeft,
  onSwipeRight,
  enabled = true,
}: UseSwipeOptions) {
  const callbacks = useRef({ onSwipeLeft, onSwipeRight });
  const start = useRef<SwipeStart | null>(null);

  useEffect(() => {
    callbacks.current = { onSwipeLeft, onSwipeRight };
  });

  return useMemo(
    () => ({
      onTouchStart: (event: ReactTouchEvent<HTMLElement>) => {
        // A second finger (or a gesture that starts on a scroller) cancels.
        if (
          !enabled ||
          event.touches.length !== 1 ||
          isSwipeExcluded(event.target, event.currentTarget)
        ) {
          start.current = null;
          return;
        }
        const touch = event.touches[0];
        start.current = { x: touch.clientX, y: touch.clientY };
      },
      onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => {
        const origin = start.current;
        start.current = null;
        if (!enabled || !origin) return;
        const touch = event.changedTouches[0];
        if (!touch) return;
        const direction = classifySwipe(
          touch.clientX - origin.x,
          touch.clientY - origin.y,
        );
        if (direction === "left") callbacks.current.onSwipeLeft();
        else if (direction === "right") callbacks.current.onSwipeRight();
      },
      onTouchCancel: () => {
        start.current = null;
      },
    }),
    [enabled],
  );
}
