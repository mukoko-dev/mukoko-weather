import { describe, it, expect } from "vitest";
import { createMountQueue } from "./mount-queue";

/** A queue whose slots are released only when the test says so. */
function harness(slots = 2) {
  const releases: Array<() => void> = [];
  const mounted: string[] = [];
  let cap = slots;
  const q = createMountQueue({
    getSlots: () => cap,
    holdSlot: (release) => releases.push(release),
  });
  const add = (id: string) => q.enqueue(() => mounted.push(id));
  return {
    q,
    add,
    mounted,
    releases,
    releaseNext: () => releases.shift()!(),
    setSlots: (n: number) => {
      cap = n;
    },
  };
}

describe("createMountQueue", () => {
  it("mounts exactly N entries at once and holds the rest", () => {
    const h = harness(2);
    for (const id of ["a", "b", "c", "d", "e"]) h.add(id);
    expect(h.mounted).toEqual(["a", "b"]);
    expect(h.q.active()).toBe(2);
    expect(h.q.pending()).toBe(3);
  });

  it("one slot means strictly one at a time", () => {
    const h = harness(1);
    for (const id of ["a", "b", "c"]) h.add(id);
    expect(h.mounted).toEqual(["a"]);
    h.releaseNext();
    expect(h.mounted).toEqual(["a", "b"]);
    expect(h.q.active()).toBe(1);
  });

  it("a released slot starts the next entry, in FIFO order", () => {
    const h = harness(2);
    for (const id of ["a", "b", "c", "d"]) h.add(id);
    h.releaseNext(); // a done
    expect(h.mounted).toEqual(["a", "b", "c"]);
    h.releaseNext(); // b done
    h.releaseNext(); // c done
    expect(h.mounted).toEqual(["a", "b", "c", "d"]);
    h.releaseNext(); // d done
    expect(h.q.active()).toBe(0);
    expect(h.q.pending()).toBe(0);
  });

  it("never exceeds the cap however many entries arrive between releases", () => {
    const h = harness(2);
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      h.add(String(i));
      peak = Math.max(peak, h.q.active());
      if (i % 3 === 0 && h.releases.length) h.releaseNext();
      peak = Math.max(peak, h.q.active());
    }
    expect(peak).toBe(2);
  });

  it("skips a cancelled entry without spending a slot", () => {
    const h = harness(1);
    h.add("a");
    const cancelB = h.add("b");
    h.add("c");
    cancelB();
    h.releaseNext();
    expect(h.mounted).toEqual(["a", "c"]);
    expect(h.q.active()).toBe(1);
  });

  it("cancelling every waiting entry leaves the queue idle, not stuck", () => {
    const h = harness(1);
    h.add("a");
    const cancels = ["b", "c", "d"].map((id) => h.add(id));
    cancels.forEach((c) => c());
    h.releaseNext();
    expect(h.mounted).toEqual(["a"]);
    expect(h.q.active()).toBe(0);
    expect(h.q.pending()).toBe(0);
    h.add("e");
    expect(h.mounted).toEqual(["a", "e"]);
  });

  it("cancelling an entry that already mounted is harmless (its slot still frees)", () => {
    const h = harness(1);
    const cancelA = h.add("a");
    h.add("b");
    cancelA();
    h.releaseNext();
    expect(h.mounted).toEqual(["a", "b"]);
  });

  it("a release called twice frees only one slot", () => {
    const h = harness(1);
    for (const id of ["a", "b", "c"]) h.add(id);
    const release = h.releases.shift()!;
    release();
    release();
    expect(h.mounted).toEqual(["a", "b"]);
    expect(h.q.active()).toBe(1);
  });

  it("a mount that throws releases its slot (no deadlock)", () => {
    const releases: Array<() => void> = [];
    const mounted: string[] = [];
    const q = createMountQueue({
      getSlots: () => 1,
      holdSlot: (r) => releases.push(r),
    });
    q.enqueue(() => {
      throw new Error("boom");
    });
    q.enqueue(() => mounted.push("next"));
    expect(mounted).toEqual(["next"]);
    expect(q.active()).toBe(1);
  });

  it("follows a cap change on the next pump", () => {
    const h = harness(1);
    for (const id of ["a", "b", "c", "d"]) h.add(id);
    h.setSlots(3);
    h.releaseNext();
    expect(h.mounted).toEqual(["a", "b", "c", "d"]);
  });

  it("treats a zero or bad cap as one slot, never zero", () => {
    const h = harness(0);
    h.add("a");
    h.add("b");
    expect(h.mounted).toEqual(["a"]);
  });
});
