import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { navigate } from "astro:transitions/client";
import { isAstroRoute } from "~/lib/routes";

/**
 * `next/navigation` for this app (one of the five seams in astro.config.mjs).
 *
 * The pathname comes from the browser's location, re-read whenever the client
 * router finishes a navigation (`astro:page-load`) or the visitor goes back
 * (`popstate`). While the island is server-rendered the pathname is the
 * page's, passed in by `RouterProvider`, so the markup the server sends is the
 * markup React hydrates.
 */
const ServerPathname = createContext("/");

export function RouterProvider({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  return (
    <ServerPathname.Provider value={pathname}>
      {children}
    </ServerPathname.Provider>
  );
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener("astro:page-load", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    document.removeEventListener("astro:page-load", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

export function usePathname(): string {
  const server = useContext(ServerPathname);
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => server,
  );
}

function go(href: string, replace: boolean): void {
  if (isAstroRoute(href)) {
    void navigate(href, { history: replace ? "replace" : "push" });
  } else if (replace) {
    window.location.replace(href);
  } else {
    window.location.assign(href);
  }
}

export function useRouter() {
  return useMemo(
    () => ({
      push: (href: string) => go(href, false),
      replace: (href: string) => go(href, true),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: () => window.location.reload(),
      prefetch: () => undefined,
    }),
    [],
  );
}
