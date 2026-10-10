"use server";

/**
 * Profile server actions — the Mukoko ecosystem standard (mukoko-news
 * `src/lib/actions/profile.ts`): write the canonical `identity.persons` record
 * first, then mirror the name to WorkOS so the identity provider does not
 * drift from it.
 *
 * There is deliberately no user-id parameter: the id comes from the verified
 * AuthKit session, so a crafted request cannot point this at another account.
 * The WorkOS mirror is best-effort — the canonical write already succeeded, so
 * a failure there must not tell the user their profile was not saved.
 */

import { revalidatePath } from "next/cache";
import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { getCurrentUser } from "@/lib/auth";
import { updateMyName } from "@/lib/profile";
import { logError, logWarn } from "@/lib/observability";
import {
  MAX_PROFILE_NAME_LENGTH,
  sanitizeProfileName,
} from "@/lib/user-display";

export type ProfileResult = { ok: true } | { ok: false; error: string };

export async function updateProfileAction(input: {
  firstName: string;
  lastName: string;
}): Promise<ProfileResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in required" };

  const first = sanitizeProfileName(input?.firstName);
  const last = sanitizeProfileName(input?.lastName);
  if (first === null || last === null) {
    return {
      ok: false,
      error: `Names must be ${MAX_PROFILE_NAME_LENGTH} characters or fewer.`,
    };
  }
  if (!first && !last) {
    return { ok: false, error: "Enter at least a first or last name." };
  }

  const written = await updateMyName(user.id, first, last);
  if (!written) {
    return {
      ok: false,
      error: "Could not save your profile. Please try again.",
    };
  }

  await mirrorNameToWorkOS(user.id, first, last);
  revalidatePath("/profile");
  return { ok: true };
}

async function mirrorNameToWorkOS(
  userId: string,
  firstName: string,
  lastName: string,
): Promise<void> {
  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
    logWarn({
      source: "unhandled",
      message:
        "WorkOS not configured — identity.persons updated, IdP not mirrored",
    });
    return;
  }
  try {
    await getWorkOS().userManagement.updateUser({
      userId,
      firstName,
      lastName,
    });
  } catch {
    // Log without the error body — WorkOS errors can echo request material.
    logError({
      source: "unhandled",
      severity: "low",
      message: "WorkOS name mirror failed; the canonical record was saved",
    });
  }
}
