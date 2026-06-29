/**
 * Sign-out route — clears the WorkOS session cookie and redirects to the
 * AuthKit-hosted sign-out flow.
 *
 * AuthKit's `signOut({ returnTo })` server action handles cookie eviction
 * and triggers the WorkOS logout endpoint, which redirects back to
 * `returnTo` once the upstream session is torn down.
 */

import { signOut } from "@workos-inc/authkit-nextjs";

export const GET = async () => {
  // `signOut` performs the redirect itself via next/navigation — it never
  // returns normally, so this handler effectively ends here.
  await signOut({ returnTo: "/" });
  // The line below is unreachable; included to satisfy the route handler
  // return-type contract in case AuthKit's behaviour changes.
  return new Response(null, { status: 307, headers: { location: "/" } });
};
