/**
 * Which banners the visitor has closed. A banner names itself with an `id`;
 * closing it remembers that id for as long as the page is open (a client-side
 * move to another place does not bring it back) and, with `remember:
 * "session"`, for the rest of the browser tab's session, through reloads.
 * Change the id when the message changes (a new frost risk, a new reason) and
 * a banner closed earlier is shown again: it is a different message.
 *
 * Nothing leaves the device and nothing is kept past the tab: the memory is a
 * `Set` and, for `session`, `sessionStorage`. No cookie, no account.
 */
export type BannerMemory = "visit" | "session";

const STORAGE_PREFIX = "mukoko-banner-closed:";

const closed = new Set<string>();
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Some browsers throw on access when storage is blocked.
    return null;
  }
}

/** Whether the banner with this id has been closed. Safe to call on the server (false). */
export function isBannerClosed(id: string, remember: BannerMemory): boolean {
  if (closed.has(id)) return true;
  if (remember !== "session") return false;
  try {
    return storage()?.getItem(STORAGE_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

/** Close the banner and tell everything that is showing it. */
export function closeBanner(id: string, remember: BannerMemory): void {
  closed.add(id);
  if (remember === "session") {
    try {
      storage()?.setItem(STORAGE_PREFIX + id, "1");
    } catch {
      // Storage full or blocked: the banner stays closed for this visit.
    }
  }
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore`'s subscribe. */
export function subscribeToBanners(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget every closed banner (tests). */
export function resetBanners(): void {
  closed.clear();
  for (const listener of listeners) listener();
}
