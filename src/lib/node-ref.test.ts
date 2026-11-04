import { describe, expect, it, vi } from "vitest";
import { setRef } from "./node-ref";

/**
 * The wrapper DialogContent puts around a caller's `ref` (React 19 ref
 * callbacks may return a cleanup, which then REPLACES the call with null).
 */
describe("setRef", () => {
  const node = { id: "node" };

  it("keeps the cleanup a function ref returns and does not call it with null", () => {
    const cleanup = vi.fn();
    const ref = vi.fn(() => cleanup);
    const release = setRef(ref, node);
    expect(ref).toHaveBeenCalledTimes(1);
    expect(ref).toHaveBeenCalledWith(node);
    release();
    expect(cleanup).toHaveBeenCalledTimes(1);
    // React 19: with a returned cleanup, the ref is never called with null.
    expect(ref).toHaveBeenCalledTimes(1);
    expect(ref).not.toHaveBeenCalledWith(null);
  });

  it("falls back to ref(null) when the function ref returned no cleanup", () => {
    const ref = vi.fn();
    const release = setRef(ref, node);
    expect(ref).toHaveBeenLastCalledWith(node);
    release();
    expect(ref).toHaveBeenCalledTimes(2);
    expect(ref).toHaveBeenLastCalledWith(null);
  });

  it("falls back to ref(null) for a return value that is not a function", () => {
    const ref = vi.fn(() => "not a cleanup" as unknown as void);
    setRef(ref, node)();
    expect(ref).toHaveBeenLastCalledWith(null);
  });

  it("sets and clears an object ref", () => {
    const ref: { current: typeof node | null } = { current: null };
    const release = setRef(ref, node);
    expect(ref.current).toBe(node);
    release();
    expect(ref.current).toBeNull();
  });

  it("does nothing without a ref", () => {
    expect(() => setRef(undefined, node)()).not.toThrow();
    expect(() => setRef(null, node)()).not.toThrow();
  });

  it("runs the cleanup once however often it is called", () => {
    const cleanup = vi.fn();
    const release = setRef(() => cleanup, node);
    release();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
