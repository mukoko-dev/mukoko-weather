/**
 * Sign-in route — redirects to the WorkOS-hosted AuthKit sign-in page.
 *
 * The actual URL is computed server-side via `getSignInUrl()` so the client
 * never sees raw WorkOS configuration. Configure this path
 * (`/auth/signin`) as the "Sign-in endpoint" / initiate_login_uri in the
 * WorkOS dashboard.
 */

import { redirect } from "next/navigation";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";

export const GET = async () => {
  const signInUrl = await getSignInUrl();
  return redirect(signInUrl);
};
