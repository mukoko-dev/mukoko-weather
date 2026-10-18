/**
 * The bounded FIFO queue behind LazySection, as a pure factory so its
 * behaviour (slot cap, slot release, cancellation, no deadlock) is tested
 * with a manual scheduler instead of a browser.
 *
 * Each started mount holds a slot until `holdSlot` calls the release it is
 * given (LazySection: after the next paint plus the settle delay). Released
 * slots start the next waiting entry. A cancelled entry is skipped without
 * taking a slot. A mount that throws still releases its slot, so one broken
 * section can never stall every section below it.
 */

export interface MountQueueOptions {
  /** How many mounts may hold a slot at once (read on every pump). */
  getSlots: () => number;
  /** Arrange for `release` to run once the mount has painted and settled. */
  holdSlot: (release: () => void) => void;
}

export interface MountQueue {
  /** Queue a mount; returns a cancel function. */
  enqueue: (mount: () => void) => () => void;
  /** Mounts holding a slot right now. */
  active: () => number;
  /** Entries waiting for a slot (cancelled ones included until skipped). */
  pending: () => number;
}

export function createMountQueue({
  getSlots,
  holdSlot,
}: MountQueueOptions): MountQueue {
  type Entry = { mount: () => void; cancelled: boolean };
  const queue: Entry[] = [];
  let active = 0;

  function pump(): void {
    const slots = Math.max(1, Math.floor(getSlots()));
    while (active < slots && queue.length > 0) {
      const next = queue.shift()!;
      if (next.cancelled) continue;
      active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        pump();
      };
      try {
        next.mount();
      } catch {
        release();
        continue;
      }
      holdSlot(release);
    }
  }

  return {
    enqueue(mount) {
      const entry: Entry = { mount, cancelled: false };
      queue.push(entry);
      pump();
      return () => {
        entry.cancelled = true;
      };
    },
    active: () => active,
    pending: () => queue.length,
  };
}
