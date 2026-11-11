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
 *
 * It does NOT own the Quick actions group (Share, Notifications, Locations):
 * whatever renders the site header draws the group with it (SiteHeader), and
 * the weather map, which has no header, draws its own. AppChrome mounts no
 * group of its own and reads no path to decide who does, so a page that
 * renders a header under a path AppChrome treats as immersive (the not-found
 * page of an unknown place's map) gets one group, not two.
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
