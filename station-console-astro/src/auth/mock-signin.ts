import type { APIRoute } from "astro";
import { MOCK_COOKIE, mockUser } from "./session";

export const prerender = false;

export const GET: APIRoute = ({ url }) => {
  const id = mockUser(url.searchParams.get("as")).id.replace(/^mock-/, "");
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `${MOCK_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`,
    },
  });
};
