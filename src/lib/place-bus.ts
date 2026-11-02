/**
 * How a pager dot, a swipe, a saved place or a search result asks the mounted
 * place stage to show a place without a page navigation.
 *
 * The stage registers while it is mounted (on `/` and `/{slug}`). A caller
 * hands `navigateToPlace` the href it would have pushed and the router's
 * `push`: when a stage can show the target it does, otherwise (no stage, a
 * sub-route, a place the stage cannot resolve) the router navigates as before.
 */

import { placeTargetOf, type PlaceTarget } from "@/lib/place-target";

export interface PlaceStageHandle {
  /** Can this stage show the target in place? ("My Location" needs a home place.) */
  canShow(target: PlaceTarget): boolean;
  /** Show it; false when it could not (the caller then navigates). */
  show(target: PlaceTarget): Promise<boolean>;
}

let active: PlaceStageHandle | null = null;

/** Register the mounted stage. Returns the unregister function. */
export function registerPlaceStage(handle: PlaceStageHandle): () => void {
  active = handle;
  return () => {
    if (active === handle) active = null;
  };
}

/** True when a stage is mounted. */
export function hasPlaceStage(): boolean {
  return active !== null;
}

/** True when the mounted stage can show My Location (`/`) in place. */
export function canShowHomeInPlace(): boolean {
  return active?.canShow({ kind: "home" }) ?? false;
}

/**
 * Go to `href`: in place when a stage can show it, else `push(href)`.
 * Returns synchronously; a stage that cannot resolve the place falls back to
 * `push` afterwards.
 */
export function navigateToPlace(
  href: string,
  push: (href: string) => void,
): void {
  const target = placeTargetOf(href);
  const stage = active;
  if (!target || !stage || !stage.canShow(target)) {
    push(href);
    return;
  }
  stage.show(target).then(
    (shown) => {
      if (!shown) push(href);
    },
    () => push(href),
  );
}

/** The slice of a click event `handlePlaceLinkClick` reads. */
export interface LinkClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * Click handler for a `<Link href>` that points at a place. A plain left
 * click is taken over (the stage shows the place; `push` is the fallback);
 * a modified click (new tab, new window, download) is left to the browser.
 * The link keeps its `href`, so it still works without JavaScript, can be
 * opened in a new tab and reads as a link to assistive technology.
 */
export function handlePlaceLinkClick(
  event: LinkClickLike,
  href: string,
  push: (href: string) => void,
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  navigateToPlace(href, push);
}
