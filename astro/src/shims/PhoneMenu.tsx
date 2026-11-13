import { User as UserIcon } from "lucide-react";

/**
 * The account control of the bottom bar, for this app (one of the five seams
 * in astro.config.mjs).
 *
 * The real one (../../src/components/layout/PhoneMenu.tsx) reads who is signed
 * in, so it cannot be part of a shell that is the same HTML for everyone. This
 * one is the link the real bar falls back to if its menu ever throws: a round
 * target to /profile, which sends a visitor who is signed out to sign-in.
 * Phase 3 of #475 (sign-in in Astro middleware) adds the signed-in avatar as a
 * small island that loads after the page has painted.
 */
export function PhoneMenu({ buttonClassName }: { buttonClassName?: string }) {
  return (
    <a
      href="/profile"
      data-astro-reload=""
      aria-label="Account"
      className={buttonClassName}
    >
      <UserIcon size={20} aria-hidden="true" />
    </a>
  );
}
