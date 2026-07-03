/**
 * Open-redirect guard for the `/auth/signin` `returnTo` param.
 *
 * Lives in its own module (not `route.ts`) because Next.js route files may
 * only export route handlers + a fixed set of config fields — exporting a
 * helper from `route.ts` fails the build type check.
 *
 * Honour a `returnTo` query param so deep-links (the AI summary sign-in CTA,
 * page-level gates) can send the user back to where they started after a
 * successful sign-in. Only same-origin paths are accepted — anything that can
 * resolve to an off-origin URL is dropped to prevent open-redirect abuse.
 */
export function sanitizeReturnPath(raw: string | null): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//")) return undefined; // protocol-relative URL
  // `/\evil.com` — a backslash after the leading slash. Browsers normalise
  // backslashes to forward slashes, turning this into a protocol-relative
  // `//evil.com` external redirect. Reject it.
  if (raw.startsWith("/\\")) return undefined;
  return raw;
}
