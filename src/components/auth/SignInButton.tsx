import Link from "next/link";

/**
 * Sign-in link. Renders as a `.kudu-sm` primary pill.
 * Navigates to `/auth/signin`, which server-side redirects to WorkOS.
 *
 * Server component — no interactivity needed; the actual sign-in URL is
 * computed on the server when the user hits `/auth/signin`.
 */
export function SignInButton({ className }: { className?: string }) {
  return (
    <Link
      href="/auth/signin"
      prefetch={false}
      aria-label="Sign in"
      className={`kudu-sm ${className ?? ""}`.trim()}
    >
      Sign in
    </Link>
  );
}
