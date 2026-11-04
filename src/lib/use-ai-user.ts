"use client";

import { useMemo } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { AISummaryUser } from "@/components/weather/AISummary";

/**
 * The signed-in person as the AI cards need them (an id and an email, nothing
 * else), read in the browser from AuthKit's provider (issue #452).
 *
 * The place pages used to ask the server for the user (`getCurrentUser`) and
 * pass it down as a prop, an extra await in front of the shell. The root
 * layout already hands the provider the session (`initialAuth`), so the first
 * render, on the server and in the browser, has the same answer: nothing
 * about the signed-in state changes for a visitor, and the page no longer
 * waits on it.
 *
 * Stable between renders (a new object only when the person changes), so a
 * dependency on it does not refire.
 */
export function useAiUser(): AISummaryUser | null {
  const { user } = useAuth();
  const id = user?.id;
  const email = user?.email;
  return useMemo(() => (id ? { id, email: email ?? null } : null), [id, email]);
}
