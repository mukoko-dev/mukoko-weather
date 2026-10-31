/**
 * True when the request's `Origin` is this site's own origin. A missing or
 * `null` Origin (a sandboxed or privacy-stripped form) is refused. Used by
 * routes that a cross-site form must not be able to trigger.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
