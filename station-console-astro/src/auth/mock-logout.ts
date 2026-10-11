import type { APIRoute } from "astro";
import { MOCK_COOKIE } from "./session";

export const prerender = false;

const clear: APIRoute = () =>
  new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `${MOCK_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });

export const GET = clear;
export const POST = clear;
