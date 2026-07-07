import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

// Same WorkOS credentials as weather.mukoko.com (shared Nyuchi identity) —
// only the redirect URI differs (this app's /callback must be registered in
// the WorkOS dashboard).
export default authkitMiddleware({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [],
  },
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
