import type { Ref } from "react";

/**
 * Point `ref` at `node` and return what undoes it. A function ref may return
 * its own cleanup (React 19); when it does, THAT is the undo and the ref is
 * not called again with null, which is the contract React itself keeps. A
 * function ref that returns nothing is called with null, and an object ref has
 * its `current` cleared.
 */
export function setRef<T>(ref: Ref<T> | undefined, node: T): () => void {
  if (typeof ref === "function") {
    const cleanup = ref(node);
    return typeof cleanup === "function"
      ? cleanup
      : () => {
          ref(null);
        };
  }
  if (ref) {
    ref.current = node;
    return () => {
      ref.current = null;
    };
  }
  return () => {};
}
