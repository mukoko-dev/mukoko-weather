/**
 * Sign-out route — clears the WorkOS session cookie and redirects to the
 * AuthKit-hosted sign-out flow.
 *
 * AuthKit's `signOut({ returnTo })` server action handles cookie eviction
 * and triggers the WorkOS logout endpoint, which redirects back to
 * `returnTo` once the upstream session is torn down.
 *
 * Two entry points, one behaviour: GET (the profile page's link) and POST
 * (the Mzizi account menu's sign-out form, `src/components/ui/app-account-menu.tsx`).
 * POST requires a same-origin `Origin` (a form on another site cannot sign a
 * visitor out) and answers 303 to the GET route, which runs the WorkOS
 * sign-out. A 303 turns the follow-up into a GET (a 307 would re-POST to the
 * AuthKit logout endpoint). The Location is relative, so a TLS-terminating
 * proxy can never turn it into an internal origin. Making GET itself refuse
 * cross-site triggers is a follow-up: the profile page links to it.
 */

import { signOut } from "@workos-inc/authkit-nextjs";
import { isSameOrigin } from "@/lib/same-origin";

export const GET = async () => {
  // `signOut` performs the redirect itself via next/navigation — it never
  // returns normally, so this handler effectively ends here.
  await signOut({ returnTo: "/" });
  // The line below is unreachable; included to satisfy the route handler
  // return-type contract in case AuthKit's behaviour changes.
  return new Response(null, { status: 307, headers: { location: "/" } });
};

export const POST = async (request: Request) => {
  if (!isSameOrigin(request)) {
    return new Response("Forbidden", { status: 403 });
  }
  // A relative reference (RFC 9110 section 10.2.2), like the GET handler's:
  // the browser resolves it against the URL it actually posted to. An absolute
  // one built from `request.url` would carry whatever origin the server thinks
  // it has, and behind a TLS-terminating proxy that can be http://localhost:PORT.
  // The same-origin check above keeps keying off `request.url`: that is the
  // Host-derived origin the Origin header has to match.
  return new Response(null, {
    status: 303,
    headers: { location: "/auth/signout" },
  });
};
