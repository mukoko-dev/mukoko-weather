import { MobileNav } from "@/components/layout/MobileNav";
import { currentLocationSlug } from "@/lib/current-slug";
import { weatherMapHref } from "@/lib/header-nav";
import { RouterProvider, usePathname } from "~/shims/next-navigation";

/**
 * The phone bottom bar with its places lane: the Next.js app's own `MobileNav`
 * (the Mzizi bottom nav, the lane, the account control), unchanged, handed the
 * device's defaults instead of the store's (see src/shims/store.ts).
 *
 * It is one island that the layout persists, so the lane keeps its scroll and
 * its place across navigations. `pathname` is the page that rendered it; after
 * that the router shim follows the browser's location.
 */
const NO_PLACES: readonly string[] = [];

function Bar() {
  const pathname = usePathname();
  const slug = currentLocationSlug(pathname, "");
  return (
    <MobileNav
      pathname={pathname}
      savedLocations={NO_PLACES}
      selectedLocation=""
      mapHref={weatherMapHref(slug)}
      hasMapLocation={Boolean(slug)}
    />
  );
}

export default function BottomBar({ pathname }: { pathname: string }) {
  return (
    <RouterProvider pathname={pathname}>
      <Bar />
    </RouterProvider>
  );
}
