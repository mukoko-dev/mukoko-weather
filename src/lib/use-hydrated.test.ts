/**
 * Tests for the useHydrated deterministic-render helper — the snapshot
 * functions that make `useSyncExternalStore` return a stable server value and
 * a client value, so time-dependent UI can avoid hydration mismatches (#418).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  useHydrated,
  getHydratedSnapshot,
  getHydratedServerSnapshot,
} from "./use-hydrated";

const source = readFileSync(resolve(__dirname, "use-hydrated.ts"), "utf-8");

describe("useHydrated — snapshot semantics", () => {
  it("server snapshot is false (stable placeholder during SSR + hydration)", () => {
    expect(getHydratedServerSnapshot()).toBe(false);
  });

  it("client snapshot is true (real content after hydration)", () => {
    expect(getHydratedSnapshot()).toBe(true);
  });

  it("server and client snapshots differ so the reveal is a post-hydration render", () => {
    expect(getHydratedServerSnapshot()).not.toBe(getHydratedSnapshot());
  });

  it("snapshots are pure — repeated calls are cached-stable (no #300 loop)", () => {
    expect(getHydratedSnapshot()).toBe(getHydratedSnapshot());
    expect(getHydratedServerSnapshot()).toBe(getHydratedServerSnapshot());
  });
});

describe("useHydrated — structure", () => {
  it("exports a useHydrated hook", () => {
    expect(typeof useHydrated).toBe("function");
  });

  it("is built on useSyncExternalStore (no setState-in-effect)", () => {
    expect(source).toContain("useSyncExternalStore");
    expect(source).not.toContain("useEffect");
  });

  it("passes both a client and a server snapshot to the store", () => {
    expect(source).toContain("getHydratedSnapshot");
    expect(source).toContain("getHydratedServerSnapshot");
  });
});
