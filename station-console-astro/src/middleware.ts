import { defineMiddleware } from "astro:middleware";
import { applyHeaders } from "./lib/headers";

/** Security and no-store headers as data (src/lib/headers.ts) on every response. */
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  return applyHeaders(response, context.url.pathname);
});
