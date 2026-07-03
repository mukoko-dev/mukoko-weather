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
import { sanitizeReturnPath } from "./sanitize";

export const GET = async (request: NextRequest) => {
  const returnTo = sanitizeReturnPath(request.nextUrl.searchParams.get("returnTo"));
  const signInUrl = await getSignInUrl(returnTo ? { returnTo } : undefined);
  return redirect(signInUrl);
};
