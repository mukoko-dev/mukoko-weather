import type { Caller } from "../lib/stations/types";

/** The slice of `Astro.locals.auth` (WorkOS or the dev mock) the console uses. */
export interface AuthLike {
  user: { id: string; email?: string | null } | null;
  accessToken?: string | undefined;
}

export function callerFrom(auth: AuthLike | undefined): Caller | null {
  if (!auth?.user) return null;
  return { personId: auth.user.id, email: auth.user.email ?? "", accessToken: auth.accessToken };
}

export const MOCK_COOKIE = "mock_session";

const MOCK_USER_RE = /^[a-z0-9-]{1,32}$/;

/** `owner` -> a stable fake identity; anything odd falls back to the default. */
export function mockUser(slug: string | undefined | null): { id: string; email: string } {
  const s = slug && MOCK_USER_RE.test(slug) ? slug : "owner";
  return { id: `mock-${s}`, email: `${s}@example.test` };
}

export function parseMockCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === MOCK_COOKIE) {
      const v = rest.join("=");
      return MOCK_USER_RE.test(v) ? v : null;
    }
  }
  return null;
}
