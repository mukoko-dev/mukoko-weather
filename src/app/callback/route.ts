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
 */

import { handleAuth } from "@workos-inc/authkit-nextjs";
import { upsertPlatformPerson, type WorkOSUser } from "@/lib/auth";
import { logError } from "@/lib/observability";

export const GET = handleAuth({
  returnPathname: "/",
  onSuccess: async ({ user }) => {
    if (!user) return;
    try {
      await upsertPlatformPerson(user as unknown as WorkOSUser);
    } catch (err) {
      // Never block sign-in on a platform-write failure. The user is already
      // authenticated via WorkOS; we'll retry the upsert on the next request.
      logError({
        source: "mongodb",
        severity: "high",
        message: "Failed to upsert identity.persons on WorkOS callback",
        error: err,
        meta: { workosUserId: (user as { id?: string }).id },
      });
    }
  },
});
