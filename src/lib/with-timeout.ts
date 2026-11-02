/**
 * Wait for `work`, but no longer than `ms`: it resolves to {@link TIMED_OUT}
 * when the time runs out. The abandoned work carries on, and a later rejection
 * of it is swallowed, so giving up on a lookup never becomes an unhandled
 * rejection. The timer is always cleared.
 */
export const TIMED_OUT = Symbol("timed-out");

export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
