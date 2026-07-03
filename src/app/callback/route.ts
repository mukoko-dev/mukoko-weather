/**
 * WorkOS AuthKit OAuth callback handler.
 *
 * After a successful sign-in at WorkOS, the user is redirected back here
 * with an authorization code. AuthKit's `handleAuth` exchanges that code
 * for a session, sets the session cookie, and invokes `onSuccess` so we
 * can mirror the WorkOS user into `identity.persons`.
 *
 * The route runs in the Node.js runtime (default) so MongoDB is reachable.
 * Configure WorkOS dashboard "Redirect URI" to point at this path.
 *
 * The `identity.persons` mirror is deferred with `after()` so it runs AFTER
 * the redirect response is flushed. Awaiting the (multi-write, sometimes
 * cold-start) MongoDB upsert made sign-in hang before returning to the app.
 * The user is already authenticated by the time we redirect; the mirror is
 * best-effort and retried on the next request if it fails.
 */

import { after } from "next/server";
import { handleAuth } from "@workos-inc/authkit-nextjs";
import { upsertPlatformPerson, type WorkOSUser } from "@/lib/auth";
import { logError } from "@/lib/observability";

export const GET = handleAuth({
  returnPathname: "/",
  onSuccess: ({ user }) => {
    if (!user) return;
    // Non-blocking: redirect first, mirror the user afterwards.
    after(async () => {
      try {
        await upsertPlatformPerson(user as unknown as WorkOSUser);
      } catch (err) {
        logError({
          source: "mongodb",
          severity: "high",
          message: "Failed to upsert identity.persons on WorkOS callback",
          error: err,
          meta: { workosUserId: (user as { id?: string }).id },
        });
      }
    });
  },
});
