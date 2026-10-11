import { defineMiddleware } from "astro:middleware";
import { mockUser, parseMockCookie } from "./session";

/** Cookie session standing in for WorkOS in development and tests. Never in production. */
export const onRequest = defineMiddleware(async (context, next) => {
  if (import.meta.env.PROD) {
    return new Response("Mock authentication is disabled in production builds.", { status: 500 });
  }
  const slug = parseMockCookie(context.request.headers.get("cookie"));
  const user = slug ? mockUser(slug) : null;
  (context.locals as unknown as { auth: unknown }).auth = {
    user,
    accessToken: user ? "mock-access-token" : undefined,
  };
  return next();
});
