import { withAuth } from "@workos-inc/authkit-nextjs";
import { Console } from "@/components/Console";

/**
 * The whole console is auth-gated (authkitMiddleware enforces sign-in on
 * every path) — station owners sign in with the same Nyuchi identity used
 * on weather.mukoko.com.
 */
export default async function Home() {
  const { user } = await withAuth({ ensureSignedIn: true });
  return <Console userEmail={user.email ?? ""} userId={user.id} />;
}
