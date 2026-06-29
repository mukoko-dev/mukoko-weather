/**
 * Sign-in route — redirects to the WorkOS-hosted AuthKit sign-in page.
 *
 * The actual URL is computed server-side via `getSignInUrl()` so the client
 * never sees raw WorkOS configuration. Configure this path
 * (`/auth/signin`) as the "Sign-in endpoint" / initiate_login_uri in the
 * WorkOS dashboard.
 */

import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";

/**
 * Honour a `returnTo` query param so deep-links (the AI summary sign-in
 * CTA, page-level gates) can send the user back to where they started
 * after a successful sign-in. Only same-origin paths are accepted —
 * anything starting with `//` or containing a scheme is dropped to
 * prevent open-redirect abuse.
 */
function sanitizeReturnPath(raw: string | null): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//")) return undefined; // protocol-relative URL
  return raw;
}

export const GET = async (request: NextRequest) => {
  const returnTo = sanitizeReturnPath(request.nextUrl.searchParams.get("returnTo"));
  const signInUrl = await getSignInUrl(returnTo ? { returnTo } : undefined);
  return redirect(signInUrl);
};
