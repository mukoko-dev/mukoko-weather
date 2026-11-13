/**
 * When the animated sky may start loading.
 *
 * The Three.js scene is about 715 KB of JavaScript in two chunks, and building
 * it opens a WebGL context. The still sky already shows the right colours, so
 * none of that is needed to read the weather: it must not compete with the
 * start-up that gets the real weather on screen on a slow phone. The sky waits
 * for two things, in order:
 *
 * 1. the weather has painted: two animation frames after the backdrop mounted
 *    (the backdrop is only rendered together with a forecast, stored or live),
 *    so a frame that shows it has been presented. A hidden tab draws no frames,
 *    so it never starts the sky at all until it is shown;
 * 2. the browser is idle (`requestIdleCallback`), or `timeoutMs` after that at
 *    the latest on a main thread that never is. Safari has no
 *    `requestIdleCallback`: there, a short timer is polled, and a main thread
 *    that is quiet is one whose timer fires on time twice in a row (see
 *    `FALLBACK_*`).
 *
 * Whether the sky moves at all (reduced motion, Save-Data, low memory, iPhone
 * and iPad) is decided before this, in `backdrop-policy.ts`; this only decides
 * WHEN. Pure of React so it is tested without a browser.
 */

/** The longest to wait for an idle moment after the weather has painted. */
export const START_IDLE_TIMEOUT_MS = 3000;

/**
 * Where the browser has no `requestIdleCallback` (Safari): a timer of this
 * many ms is polled, and one that fires more than `FALLBACK_BUSY_LATE_MS` late
 * means the main thread was busy. `FALLBACK_QUIET_POLLS` on-time polls in a
 * row count as idle, so the earliest start is two polls (100 ms) after the
 * second frame.
 */
export const FALLBACK_POLL_MS = 50;
export const FALLBACK_BUSY_LATE_MS = 16;
export const FALLBACK_QUIET_POLLS = 2;

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * Run `start` once, after the next two frames and then an idle moment. Returns
 * the canceller: call it on unmount, or when the effect re-runs, and `start`
 * never fires.
 */
export function afterPaintWhenIdle(
  start: () => void,
  timeoutMs: number = START_IDLE_TIMEOUT_MS,
): () => void {
  const w = window as IdleWindow;
  let cancelled = false;
  let frame = 0;
  let idle: number | undefined;
  let timer: number | undefined;

  const fire = () => {
    if (!cancelled) start();
  };
  const whenIdle = () => {
    if (cancelled) return;
    if (typeof w.requestIdleCallback === "function") {
      idle = w.requestIdleCallback(fire, { timeout: timeoutMs });
      return;
    }
    const deadline = Date.now() + timeoutMs;
    let expected = Date.now() + FALLBACK_POLL_MS;
    let quiet = 0;
    const poll = () => {
      if (cancelled) return;
      const now = Date.now();
      quiet = now - expected < FALLBACK_BUSY_LATE_MS ? quiet + 1 : 0;
      if (quiet >= FALLBACK_QUIET_POLLS || now >= deadline) return fire();
      expected = now + FALLBACK_POLL_MS;
      timer = window.setTimeout(poll, FALLBACK_POLL_MS);
    };
    timer = window.setTimeout(poll, FALLBACK_POLL_MS);
  };

  // Two frames: the first is the one the render committed into, the second
  // means that frame has been presented.
  frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(whenIdle);
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    if (idle !== undefined) w.cancelIdleCallback?.(idle);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
