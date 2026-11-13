"use client";

import { useEffect } from "react";
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
  // The root not-found page (an unmatched URL, a place the proxy knows is
  // unknown) has no stylesheet of its own: a root boundary file cannot import
  // the sheet without announcing it to every route as a preload of all 213 KB,
  // which is what the first screen avoids (issue 551). It asks for it here, from
  // script, where every route already loads this component, so no route loads
  // anything new. A dynamic import of a stylesheet is a link that nothing waits
  // for; on a page that already links the sheet it finds it there.
  useEffect(() => {
    if (document.getElementById("not-found-heading"))
      void import("@/app/globals.css").catch(() => {});
  }, [pathname]);
  return (
    <ChromeContext.Provider value={claimed}>
      {claimed && <SiteHeader />}
      {children}
      {claimed && <SiteFooter />}
    </ChromeContext.Provider>
  );
}
