"use client";

import { useEffect, useSyncExternalStore, type RefObject } from "react";

/**
 * The sky hero on screen, as the Quick actions group sees it.
 *
 * The group lives in the layout (one mount for the whole app) and the hero
 * lives in a page, so the page tells the layout two things: where the hero's
 * content is (the group watches it to know whether only sky is still behind
 * it) and which place the hero shows (so Share says "Share weather for
 * Harare" there and "Share this page" everywhere else). A tiny external store
 * carries both; nothing here reads the DOM by selector and nothing listens to
 * scroll.
 *
 * The group is clear over the sky, and the sky is a clean background only
 * until the hero's own content (the place name, the temperature) slides up
 * under it: white icons over white numerals read as neither. So "the sky is
 * behind the group" means the hero's first line of content has not reached
 * the group yet: the group is clear at the top of a place page and turns solid
 * as soon as the page moves that line up to it. (The line, not the block that
 * holds it: the block starts with a padding of bare sky that sits above the
 * line, and on a phone whose breadcrumb is one line the block's edge is
 * already above the group's bottom edge at rest.)
 */

/** The place the hero shows: what Share names and links to. */
export interface SkyHeroPlace {
  name: string;
  /** Absent when the place has no canonical URL: Share then links this page. */
  slug?: string;
}

export interface SkyHero {
  /**
   * The hero's first line of content, the part under the strip of bare sky
   * the group sits in (the top row leaves it room). The group is clear while
   * this is still below the group.
   */
  content: HTMLElement;
  /** Null for the loading skeleton, which has a hero's box but no place yet. */
  place: SkyHeroPlace | null;
}

let current: SkyHero | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Put a hero on the store. Returns the cleanup, which removes it only if it is
 * still the registered one (a newer hero that mounted first is never undone by
 * an older one unmounting late).
 */
export function registerSkyHero(
  content: HTMLElement,
  place: SkyHeroPlace | null,
): () => void {
  const entry: SkyHero = { content, place };
  current = entry;
  emit();
  return () => {
    if (current !== entry) return;
    current = null;
    emit();
  };
}

/** Call `listener` whenever the registered hero changes. Returns the cleanup. */
export function subscribeSkyHero(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The registered hero right now, or null when the page has none. */
export function getSkyHero(): SkyHero | null {
  return current;
}

/** The registered hero, or null when the page has none. Null on the server. */
export function useSkyHero(): SkyHero | null {
  return useSyncExternalStore(subscribeSkyHero, getSkyHero, () => null);
}

/**
 * Register the element in `ref` (the hero's first line of content) as the page's sky
 * hero while the calling component is mounted. The hero and its loading
 * skeleton both call this, so the group's look is continuous across the swap.
 */
export function useRegisterSkyHero(
  ref: RefObject<HTMLElement | null>,
  place: SkyHeroPlace | null,
): void {
  const name = place?.name;
  const slug = place?.slug;
  useEffect(() => {
    const content = ref.current;
    if (!content) return;
    return registerSkyHero(content, name === undefined ? null : { name, slug });
  }, [ref, name, slug]);
}

/**
 * How far above the viewport the observed band reaches. The hero's content
 * can be scrolled any distance up and out of the page; it must still count as
 * "reached the group".
 */
const BAND_REACH_PX = 100_000;

/**
 * The IntersectionObserver `rootMargin` for "the hero's content has reached
 * the group": the root becomes everything from far above the page down to the
 * group's bottom edge, so the content line intersects it as soon as its top
 * edge is above the group's bottom edge, and keeps intersecting while it
 * scrolls up and away. While it does not intersect, only bare sky is behind
 * the group. (A group that is not laid out, bottom 0, leaves nothing to
 * reach.)
 */
export function skyBandRootMargin(
  groupBottom: number,
  viewportHeight: number,
): string {
  const edge = Number.isFinite(groupBottom) ? Math.max(0, groupBottom) : 0;
  const below = Math.max(0, Math.round(viewportHeight - edge));
  return `${BAND_REACH_PX}px 0px ${-below}px 0px`;
}

/** The slice of `window` the watcher uses (the tests pass a fake one). */
export interface ObserveWindow {
  innerHeight: number;
  IntersectionObserver?: typeof IntersectionObserver;
  addEventListener: (type: "resize", listener: () => void) => void;
  removeEventListener: (type: "resize", listener: () => void) => void;
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
}

interface WatchOptions {
  /** The hero's first line of content (see `SkyHero.content`). */
  content: Element;
  group: Element;
  /** True while only bare sky is behind the group. Called with each change. */
  onChange: (behind: boolean) => void;
  win?: ObserveWindow;
}

/**
 * Tell `onChange` whether bare sky is still behind the group (the hero's
 * content has not reached it), with an IntersectionObserver (never a scroll
 * listener: the browser says when the content crosses the group's edge and the
 * page does no work in between). The observer is made again when the window is
 * resized or turned, because the group's bottom edge (the band) moves with the
 * layout. Returns the cleanup.
 *
 * Without IntersectionObserver the answer is "not behind", so the group takes
 * its solid look, which reads on any background.
 */
export function watchSkyBehindGroup({
  content,
  group,
  onChange,
  win = window as unknown as ObserveWindow,
}: WatchOptions): () => void {
  const Observer = win.IntersectionObserver;
  if (typeof Observer !== "function") {
    onChange(false);
    return () => undefined;
  }

  let observer: IntersectionObserver | null = null;
  let frame = 0;

  const observe = () => {
    observer?.disconnect();
    observer = new Observer(
      (entries) => {
        // The last entry is the newest.
        const entry = entries[entries.length - 1];
        if (entry) onChange(!entry.isIntersecting);
      },
      {
        rootMargin: skyBandRootMargin(
          group.getBoundingClientRect().bottom,
          win.innerHeight,
        ),
        threshold: 0,
      },
    );
    observer.observe(content);
  };

  const onResize = () => {
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(observe);
  };

  observe();
  win.addEventListener("resize", onResize);
  return () => {
    win.cancelAnimationFrame(frame);
    win.removeEventListener("resize", onResize);
    observer?.disconnect();
    observer = null;
  };
}
