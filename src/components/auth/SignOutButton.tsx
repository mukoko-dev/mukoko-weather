import Link from "next/link";

/**
 * Sign-out link. Renders as `.impala` outline pill so it reads as a
 * secondary action paired with profile info.
 *
 * Server component — same pattern as {@link SignInButton}: navigation to
 * `/auth/signout` triggers a server-side redirect to the WorkOS sign-out
 * flow, which clears the session cookie.
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <Link
      href="/auth/signout"
      prefetch={false}
      aria-label="Sign out"
      className={`impala ${className ?? ""}`.trim()}
    >
      Sign out
    </Link>
  );
}
