"use client";

import { usePathname } from "next/navigation";

import { SiteFooter } from "@/components/layout/Footer";
import { SiteHeader } from "@/components/layout/Header";
import {
  ChromeContext,
  isImmersivePath,
} from "@/components/layout/chrome-context";

/**
 * The header, footer and mobile bottom nav, mounted once in the root layout so they
 * survive navigation: the scroll state, the open menus and the location
 * pager keep their place instead of being torn down and rebuilt on every tap.
 *
 * Pages still render `<Header />` (and the loaders `<HeaderSkeleton />`); while
 * the chrome is claimed here those render nothing, so a page can be moved
 * over one at a time and never shows two headers.
 */
export function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const claimed = !isImmersivePath(pathname ?? "");
  return (
    <ChromeContext.Provider value={claimed}>
      {claimed && <SiteHeader />}
      {children}
      {claimed && <SiteFooter />}
    </ChromeContext.Provider>
  );
}
