import { handleAuth } from "@workos-inc/authkit-nextjs";

// Same WorkOS environment as weather.mukoko.com — register
// https://weatherstations.nyuchi.com/callback as an additional redirect URI
// in the WorkOS dashboard.
export const GET = handleAuth();
