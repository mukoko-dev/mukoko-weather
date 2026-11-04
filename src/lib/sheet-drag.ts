/**
 * Pull down to dismiss, for the phone bottom sheet (issue #482).
 *
 * One transform on one element, written straight to `style` from the event
 * handlers: no React state per frame, no animation library. The decisions are
 * the pure functions at the top (tested in node); `attachSheetDrag` is the DOM
 * glue the shared `DialogContent` (src/components/ui/dialog.tsx) attaches to
 * every modal, so no modal carries its own copy.
 *
 * Where a drag may start (the sheet follows the finger from there):
 *   - the pinned top bar (`[data-sheet-drag]`: grab pill, title, Close), always,
 *     through pointer events (the bar is `touch-action: none`, so the browser
 *     never takes the gesture for a scroll);
 *   - the content, only while nothing under the finger can scroll up (the
 *     scroller is at its top), through touch events, because a browser turns a
 *     pull on a scroller into a pan and cancels the pointer events. That
 *     `touchmove` listener is added only for a gesture that can become a pull,
 *     so an ordinary scroll inside the sheet keeps the browser's own fast path.
 * Never from a text field, a slider, a chart, `[data-no-swipe]` or a sideways
 * scroller. The close button stays the accessible way out; this is the
 * enhancement.
 */
import { SM_UP_QUERY } from "@/lib/breakpoints";
import { readReducedMotion } from "@/lib/harness";
import { isSwipeExcluded } from "@/lib/use-swipe";

/**
 * Travel on the larger axis before a gesture is read at all. Finger jitter and
 * the first, coarse move of a touch are smaller than this and decide nothing.
 */
export const SHEET_AXIS_DECIDE_PX = 6;
/**
 * A gesture is "clearly sideways" only when its horizontal travel is this many
 * times its vertical travel; anything between is still undecided.
 */
export const SHEET_SIDEWAYS_RATIO = 1.5;
/** A pull is released as a dismissal past this share of the sheet's height... */
export const SHEET_DISMISS_RATIO = 0.25;
/** ...but never closer than this (a twitch must not close it)... */
export const SHEET_DISMISS_MIN_PX = 80;
/** ...nor farther than this (a tall sheet must not need a long pull). */
export const SHEET_DISMISS_MAX_PX = 160;
/** A fling at this speed (CSS px per ms, 600 px/s) closes it from a short pull. */
export const SHEET_FLING_VELOCITY = 0.6;
/** The shortest pull a fling can close from. */
export const SHEET_FLING_MIN_PX = 24;
/** A finger that rested this long before lifting has no velocity. */
export const SHEET_REST_MS = 100;
/** Slide out, then spring back, in milliseconds. */
export const SHEET_EXIT_MS = 180;
export const SHEET_RESTORE_MS = 240;
/** After asking the dialog to close, this long to see whether it began to. */
export const SHEET_REFUSAL_CHECK_MS = 60;

export type SheetRelease = "dismiss" | "restore";

/** The pull that closes a sheet of this height. */
export function dismissDistance(height: number): number {
  const share = Number.isFinite(height) ? height * SHEET_DISMISS_RATIO : 0;
  return Math.min(SHEET_DISMISS_MAX_PX, Math.max(SHEET_DISMISS_MIN_PX, share));
}

/** What to do when the finger lifts: close past the distance or on a fling. */
export function decideRelease(input: {
  /** How far down the sheet was pulled, px. */
  offset: number;
  /** Downward speed at release, px per ms. */
  velocity: number;
  /** The sheet's height, px. */
  height: number;
}): SheetRelease {
  const { offset, velocity, height } = input;
  if (!(offset > 0)) return "restore";
  if (offset >= dismissDistance(height)) return "dismiss";
  if (offset >= SHEET_FLING_MIN_PX && velocity >= SHEET_FLING_VELOCITY) {
    return "dismiss";
  }
  return "restore";
}

export type MoveReading = "undecided" | "pull" | "other";

/**
 * Read a gesture that has moved (dx, dy) from where the finger came down.
 *
 * It decides only once the travel is decisive (SHEET_AXIS_DECIDE_PX on the
 * larger axis, a pull needing that much DOWNWARD), and gives a gesture up only
 * when it is clearly upward or clearly sideways. A first move such as dx 3,
 * dy 2 is jitter: undecided, not a reason to hand a real pull to the browser
 * for the rest of the touch.
 */
export function readMove(dx: number, dy: number): MoveReading {
  const down = dy;
  const across = Math.abs(dx);
  if (down >= SHEET_AXIS_DECIDE_PX && down >= across) return "pull";
  if (down <= -SHEET_AXIS_DECIDE_PX) return "other";
  if (
    across >= SHEET_AXIS_DECIDE_PX &&
    across > SHEET_SIDEWAYS_RATIO * Math.abs(dy)
  ) {
    return "other";
  }
  return "undecided";
}

/** A smoothed downward speed: the new sample leans 60%, the old 40%. */
export function smoothVelocity(
  previous: number,
  deltaY: number,
  deltaMs: number,
): number {
  if (!(deltaMs > 0)) return previous;
  return 0.6 * (deltaY / deltaMs) + 0.4 * previous;
}

/**
 * The speed after one more move. The first sample is taken as it is: smoothing
 * it against a zero that was never measured would under-read a short, quick
 * flick, which has only two or three moves to go on.
 */
export function nextVelocity(
  previous: number,
  samples: number,
  deltaY: number,
  deltaMs: number,
): number {
  if (!(deltaMs > 0)) return previous;
  return samples === 0
    ? deltaY / deltaMs
    : smoothVelocity(previous, deltaY, deltaMs);
}

/** The speed to release with: zero when the finger rested before lifting. */
export function releaseVelocity(
  velocity: number,
  lastMoveAt: number,
  releasedAt: number,
): number {
  return releasedAt - lastMoveAt > SHEET_REST_MS ? 0 : velocity;
}

/** What `canScrollUp` needs to know about one element on the way up. */
export interface ScrollProbe {
  overflowY: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * True when any element between the finger and the sheet scrolls vertically
 * and is not at its top: a pull down there means "scroll back up", not "close".
 */
export function canScrollUp(chain: readonly ScrollProbe[]): boolean {
  return chain.some(
    (probe) =>
      (probe.overflowY === "auto" ||
        probe.overflowY === "scroll" ||
        probe.overflowY === "overlay") &&
      probe.scrollHeight > probe.clientHeight &&
      probe.scrollTop > 0,
  );
}

/** Elements a pull must never start on: fields, sliders, charts, opt-outs. */
export const SHEET_NO_DRAG_SELECTOR =
  'input, textarea, select, canvas, [contenteditable=""], [contenteditable="true"], [role="slider"], [data-no-sheet-drag]';

/** Elements in the bar that are controls, not a handle. */
const BAR_CONTROL_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="tab"]';

/** Attribute that marks the pinned, always-draggable top bar. */
export const SHEET_DRAG_ATTRIBUTE = "data-sheet-drag";
/** Set while the sheet slides out, so Radix's own exit animation does not replay. */
export const SHEET_CLOSING_ATTRIBUTE = "data-sheet-closing";

export interface SheetDragOptions {
  /** Close the dialog. The shared content clicks its own Close button. */
  dismiss: () => void;
}

type Kind = "pointer" | "touch";

interface Gesture {
  kind: Kind;
  id: number;
  x0: number;
  y0: number;
  /** Where the sheet already was when the finger came down (a spring in flight). */
  base: number;
  dragging: boolean;
  offset: number;
  velocity: number;
  /** Moves measured so far (the first is taken as it is, see nextVelocity). */
  samples: number;
  lastY: number;
  lastAt: number;
}

/** A phone is a viewport below `sm`: the one that does NOT match SM_UP_QUERY. */
const isPhone = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  !window.matchMedia(SM_UP_QUERY).matches;

/** True while a CSS animation (not a transition) is running on the element. */
function runsCssAnimation(el: HTMLElement): boolean {
  if (typeof el.getAnimations !== "function") return false;
  return el
    .getAnimations()
    .some(
      (animation) =>
        (animation as CSSAnimation).animationName !== undefined &&
        animation.playState === "running",
    );
}

function scrollChain(target: Element, root: Element): ScrollProbe[] {
  const chain: ScrollProbe[] = [];
  let node: Element | null = target;
  while (node) {
    chain.push({
      overflowY: window.getComputedStyle(node).overflowY,
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    });
    if (node === root) break;
    node = node.parentElement;
  }
  return chain;
}

/** The sheet's current vertical offset, so a new pull continues from it. */
function currentOffset(el: HTMLElement): number {
  if (!el.style.transform) return 0;
  try {
    const matrix = new DOMMatrix(window.getComputedStyle(el).transform);
    return Number.isFinite(matrix.m42) ? Math.max(0, matrix.m42) : 0;
  } catch {
    return 0;
  }
}

/**
 * Make `el` (the dialog's content) pull-down-dismissable on phones. Returns the
 * function that removes every listener and timer; call it when the content
 * unmounts.
 */
export function attachSheetDrag(
  el: HTMLElement,
  options: SheetDragOptions,
): () => void {
  let gesture: Gesture | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers.clear();
  };

  /** Back to the stylesheet's own state. */
  const reset = () => {
    el.style.transform = "";
    el.style.transition = "";
    el.style.willChange = "";
    el.removeAttribute(SHEET_CLOSING_ATTRIBUTE);
  };

  const spring = () => {
    if (readReducedMotion()) {
      reset();
      return;
    }
    el.style.transition = `transform ${SHEET_RESTORE_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1)`;
    el.style.transform = "translate3d(0, 0, 0)";
    later(reset, SHEET_RESTORE_MS + 30);
  };

  const close = () => {
    el.setAttribute(SHEET_CLOSING_ATTRIBUTE, "");
    options.dismiss();
    // A dialog that did not begin to close (a guarded `onOpenChange`, a
    // controlled `open` that stays true) must not be left off-screen: give it a
    // moment, then bring the sheet back.
    later(() => {
      if (el.isConnected && el.getAttribute("data-state") === "open") {
        el.removeAttribute(SHEET_CLOSING_ATTRIBUTE);
        spring();
      }
    }, SHEET_REFUSAL_CHECK_MS);
  };

  const slideOut = () => {
    if (readReducedMotion()) {
      close();
      return;
    }
    el.style.transition = `transform ${SHEET_EXIT_MS}ms ease-in`;
    el.style.transform = "translate3d(0, 100%, 0)";
    later(close, SHEET_EXIT_MS + 20);
  };

  const begin = (
    kind: Kind,
    id: number,
    x: number,
    y: number,
    at: number,
  ): Gesture => {
    return {
      kind,
      id,
      x0: x,
      y0: y,
      base: currentOffset(el),
      dragging: false,
      offset: 0,
      velocity: 0,
      samples: 0,
      lastY: y,
      lastAt: at,
    };
  };

  /** Returns true when the gesture is (now) a pull, so the caller can stop the scroll. */
  const move = (g: Gesture, x: number, y: number, at: number): boolean => {
    const dx = x - g.x0;
    const dy = y - g.y0;
    if (!g.dragging) {
      const reading = readMove(dx, dy);
      if (reading === "undecided") return false;
      if (reading === "other") {
        // Clearly upward or sideways: not ours. Let the browser scroll.
        gesture = null;
        return false;
      }
      if (runsCssAnimation(el)) {
        // The slide-up (or a slide-down) is still running and its transform
        // would override ours: the sheet would not follow the finger.
        gesture = null;
        return false;
      }
      g.dragging = true;
      // Catching a sheet that is still springing back or sliding out.
      clearTimers();
      el.style.transition = "none";
      el.style.willChange = "transform";
    }
    g.offset = Math.max(0, g.base + dy);
    g.velocity = nextVelocity(
      g.velocity,
      g.samples,
      y - g.lastY,
      at - g.lastAt,
    );
    g.samples += 1;
    g.lastY = y;
    g.lastAt = at;
    el.style.transform = `translate3d(0, ${g.offset}px, 0)`;
    return true;
  };

  const release = (g: Gesture, at: number, cancelled: boolean) => {
    if (!g.dragging) return;
    const decision = cancelled
      ? "restore"
      : decideRelease({
          offset: g.offset,
          velocity: releaseVelocity(g.velocity, g.lastAt, at),
          height: el.offsetHeight,
        });
    if (decision === "dismiss") slideOut();
    else spring();
  };

  // ── Pointer path: the pinned bar ────────────────────────────────────────

  const onPointerDown = (event: PointerEvent) => {
    if (!isPhone()) return;
    if (!event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const bar = target.closest(`[${SHEET_DRAG_ATTRIBUTE}]`);
    if (!bar || !el.contains(bar)) return;
    if (target.closest(BAR_CONTROL_SELECTOR)) return;
    gesture = begin(
      "pointer",
      event.pointerId,
      event.clientX,
      event.clientY,
      event.timeStamp,
    );
  };

  const onPointerMove = (event: PointerEvent) => {
    const g = gesture;
    if (!g || g.kind !== "pointer" || g.id !== event.pointerId) return;
    const wasDragging = g.dragging;
    move(g, event.clientX, event.clientY, event.timeStamp);
    if (!wasDragging && g.dragging) {
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is gone already; the release below handles it.
      }
    }
  };

  const onPointerEnd = (event: PointerEvent) => {
    const g = gesture;
    if (!g || g.kind !== "pointer" || g.id !== event.pointerId) return;
    gesture = null;
    release(g, event.timeStamp, event.type === "pointercancel");
  };

  // ── Touch path: the content, only while it is at its top ────────────────

  const onTouchMove = (event: TouchEvent) => {
    const g = gesture;
    if (!g || g.kind !== "touch") return;
    if (event.touches.length !== 1) {
      endTouch(event, true);
      return;
    }
    const touch = event.touches[0];
    if (move(g, touch.clientX, touch.clientY, event.timeStamp)) {
      // Stop the scroller's rubber band: this finger is moving the sheet.
      if (event.cancelable) event.preventDefault();
    } else if (!gesture) {
      el.removeEventListener("touchmove", onTouchMove);
    }
  };

  const endTouch = (event: TouchEvent, cancelled: boolean) => {
    const g = gesture;
    el.removeEventListener("touchmove", onTouchMove);
    if (!g || g.kind !== "touch") return;
    gesture = null;
    release(g, event.timeStamp, cancelled);
  };

  const onTouchStart = (event: TouchEvent) => {
    if (!isPhone()) return;
    if (event.touches.length !== 1) {
      if (gesture?.kind === "touch") endTouch(event, true);
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    // The bar belongs to the pointer path.
    if (target.closest(`[${SHEET_DRAG_ATTRIBUTE}]`)) return;
    if (target.closest(SHEET_NO_DRAG_SELECTOR)) return;
    if (isSwipeExcluded(target, el)) return;
    if (canScrollUp(scrollChain(target, el))) return;
    const touch = event.touches[0];
    gesture = begin(
      "touch",
      touch.identifier,
      touch.clientX,
      touch.clientY,
      event.timeStamp,
    );
    // Only a gesture that can become a pull blocks the browser's fast scroll.
    el.addEventListener("touchmove", onTouchMove, { passive: false });
  };

  const onTouchEnd = (event: TouchEvent) => endTouch(event, false);
  const onTouchCancel = (event: TouchEvent) => endTouch(event, true);

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerEnd);
  el.addEventListener("pointercancel", onPointerEnd);
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onTouchCancel, { passive: true });

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerEnd);
    el.removeEventListener("pointercancel", onPointerEnd);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchCancel);
    clearTimers();
    gesture = null;
  };
}
