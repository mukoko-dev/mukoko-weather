/**
 * Shared JSON fetch helpers.
 *
 * `fetchJson` never throws: it resolves to `null` on a non-OK status, a
 * network error, an abort/timeout, or a body that isn't valid JSON. Callers
 * that need the failure reason use `fetchJsonOrThrow`, which throws a
 * `FetchJsonError` for non-OK responses and lets the native error through for
 * everything else.
 *
 * Requests send `accept: application/json` unless the caller sets its own.
 *
 * Dependency-free on purpose: imported by the Edge embed route and the
 * embeddable widget bundle as well as client components.
 */

export interface FetchJsonOptions {
  /** Abort the request after this many ms. No timeout when omitted. */
  timeoutMs?: number;
  /** Caller cancellation. Aborting it aborts the request. */
  signal?: AbortSignal;
  /** Extra RequestInit (headers, method, …). `init.signal` is honoured like `signal`. */
  init?: RequestInit;
}

export class FetchJsonError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`Request to ${url} failed (HTTP ${status})`);
    this.name = "FetchJsonError";
    this.status = status;
  }
}

/**
 * Fetch and parse JSON, throwing on failure. A timeout surfaces as the
 * native AbortError-style rejection from `fetch`.
 */
export async function fetchJsonOrThrow<T>(
  url: string,
  { timeoutMs, signal, init }: FetchJsonOptions = {},
): Promise<T> {
  const callerSignal = signal ?? init?.signal ?? undefined;
  const controller = new AbortController();

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer =
    timeoutMs !== undefined
      ? setTimeout(
          () =>
            controller.abort(
              new DOMException("Request timed out", "TimeoutError"),
            ),
          timeoutMs,
        )
      : undefined;

  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    const res = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) throw new FetchJsonError(res.status, url);
    return (await res.json()) as T;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Fetch and parse JSON. Resolves to `null` on any failure; never throws. */
export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T | null> {
  try {
    return await fetchJsonOrThrow<T>(url, options);
  } catch {
    return null;
  }
}
