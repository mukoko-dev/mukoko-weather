import type { APIRoute } from "astro";

export const prerender = false;

/**
 * The account menu signs out with a POST form (so no other page can trigger
 * it with a link). The WorkOS logout route only takes GET, so this hands over
 * to it; the mock session has the same /auth/logout route.
 */
const handoff: APIRoute = ({ redirect }) => redirect("/auth/logout", 303);

export const GET = handoff;
export const POST = handoff;
