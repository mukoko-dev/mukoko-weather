import { isDestinationActive } from "@/lib/header-nav";

/**
 * Mark the persisted header after a navigation or a scroll: the link of the
 * current page gets `aria-current="page"` and the `weaver-active` look, and
 * the header gets `data-scrolled` once the page is 20px down (the Next.js
 * header's rule). Reads the DOM only; safe to call as often as scroll fires.
 */
export function markHeader(): void {
  const header = document.querySelector<HTMLElement>("[data-site-header]");
  if (!header) return;
  header.toggleAttribute("data-scrolled", window.scrollY > 20);
  const path = window.location.pathname;
  for (const link of header.querySelectorAll<HTMLAnchorElement>(
    "[data-nav-href]",
  )) {
    const active = isDestinationActive(path, link.dataset.navHref ?? "");
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
    link.classList.toggle("weaver-active", active);
    link.classList.toggle("weaver", !active);
  }
}
