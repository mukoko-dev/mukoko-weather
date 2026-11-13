import { forwardRef, type AnchorHTMLAttributes } from "react";
import { isAstroRoute } from "~/lib/routes";

/**
 * `next/link` for this app (one of the five seams in astro.config.mjs).
 *
 * A plain anchor: the client router (`ClientRouter`, in the layout) listens
 * for clicks on the document, so an anchor inside a React island is routed
 * without any code here. A link to a page the Next.js app still owns gets
 * `data-astro-reload`, which makes the router do a full page load instead of
 * fetching a page it cannot swap in.
 */
interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  href: string;
  /** Accepted and ignored: Astro's prefetch is a layout setting. */
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, prefetch: _prefetch, replace: _replace, scroll: _scroll, ...rest },
  ref,
) {
  const reload = isAstroRoute(href) ? {} : { "data-astro-reload": "" };
  return <a ref={ref} href={href} {...reload} {...rest} />;
});

export default Link;
