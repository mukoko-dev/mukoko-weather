"use client";

/**
 * Keeps a signed-in person's activities on their profile
 * (mukoko-dev/mukoko-weather#484). Renders nothing. Mounted once in the root
 * layout, inside the AuthKit provider, so it runs on every page and not only
 * on the home page. Off, and inert, until `PERSON_PREFERENCES_READY` is
 * flipped (`person-preferences.ts`); anonymous visitors do nothing.
 */

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { usePersonPreferencesSync } from "@/lib/use-person-preferences-sync";

export function PersonPreferencesSync() {
  const { user } = useAuth();
  usePersonPreferencesSync(user?.id ?? null);
  return null;
}
