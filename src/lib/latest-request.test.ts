import { describe, expect, it } from "vitest";
import { createLatestRequests } from "./latest-request";

/** A fetch that answers when told to, and rejects when aborted. */
function pending(signal: AbortSignal) {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    signal.addEventListener("abort", () => rej(signal.reason), { once: true });
  });
  return { promise, resolve };
}

describe("createLatestRequests", () => {
  it("makes the first request the latest", () => {
    const r = createLatestRequests().begin();
    expect(r.isLatest()).toBe(true);
    expect(r.signal.aborted).toBe(false);
  });

  it("aborts the request in flight when a newer one begins", () => {
    const requests = createLatestRequests();
    const first = requests.begin();
    const second = requests.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isLatest()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isLatest()).toBe(true);
  });

  it("lets a slow old answer arrive without it being allowed to set state", async () => {
    // The page: ask for 5 years of place A, then 7 days of place B. A's answer
    // arrives LAST and must not overwrite B's.
    const requests = createLatestRequests();
    let shown = "";
    const run = async (label: string, answerAfter: "now" | "later") => {
      const req = requests.begin();
      const call = pending(req.signal);
      if (answerAfter === "now") call.resolve(label);
      try {
        const text = await call.promise;
        if (!req.isLatest()) return;
        shown = text;
      } catch {
        // Aborted: superseded.
      }
    };
    const slowOld = run("A: 5 years", "later");
    await run("B: 7 days", "now");
    await slowOld;
    expect(shown).toBe("B: 7 days");
  });

  it("ignores an old answer even when it ignores the abort and resolves anyway", async () => {
    // A fetch that did not honour the signal: the check still holds.
    const requests = createLatestRequests();
    const old = requests.begin();
    const oldAnswer = Promise.resolve("old");
    requests.begin();
    let shown = "";
    const text = await oldAnswer;
    if (old.isLatest()) shown = text;
    expect(shown).toBe("");
  });

  it("makes nothing the latest after cancel (leaving the page)", () => {
    const requests = createLatestRequests();
    const r = requests.begin();
    requests.cancel();
    expect(r.signal.aborted).toBe(true);
    expect(r.isLatest()).toBe(false);
    // A later begin works again.
    const next = requests.begin();
    expect(next.isLatest()).toBe(true);
  });

  it("is safe to cancel with nothing in flight", () => {
    const requests = createLatestRequests();
    expect(() => requests.cancel()).not.toThrow();
    expect(() => requests.cancel()).not.toThrow();
  });
});
