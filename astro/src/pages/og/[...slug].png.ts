/**
 * Every card image, drawn at build time and served as a static file:
 * /og/site.png, /og/pages/<page>.png and /og/locations/<slug>.png. No code
 * runs when a scraper fetches one. The drawing (satori, sharp) lives in
 * `lib/og/render.ts` and is build-only.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { allCards, type OgCard } from "~/lib/og/cards";
import { renderCard } from "~/lib/og/render";

export const prerender = true;

export const getStaticPaths = (() =>
  allCards().map((card) => ({
    params: { slug: card.slug },
    props: { card },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
  const { card } = props as { card: OgCard };
  const png = await renderCard(card.spec);
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png" },
  });
};
