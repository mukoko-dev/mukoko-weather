/** Response headers as data, applied by src/middleware.ts to every response. */

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** The BFF carries one-time ingest keys: nothing may cache them. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

export function applyHeaders(response: Response, pathname: string): Response {
  const noStore = pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname === "/";
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (noStore) for (const [k, v] of Object.entries(NO_STORE_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
