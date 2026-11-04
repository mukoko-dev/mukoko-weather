// Shared "Location not found" UI — rendered by the root `not-found.tsx`, which
// catches `[location]` pages and sub-routes too, so an unknown slug looks the
// same however it is reached. The layout (PageShell, skip-link target, bottom
// clearance) lives in NotFoundView.
import { getLocationsForContext } from "@/lib/db";
import { CitySuggestions } from "@/components/layout/CitySuggestions";
import { NotFoundView } from "@/components/layout/NotFoundView";

export async function LocationNotFound() {
  let locations: { slug: string; name: string }[] = [];
  try {
    locations = await getLocationsForContext(20);
  } catch {
    // MongoDB unavailable — show a minimal 404 without locations list
  }

  return (
    <NotFoundView
      title="Location not found"
      message="We don't have weather data for that location yet."
      actions={[{ href: "/explore", label: "Browse locations", primary: true }]}
    >
      <CitySuggestions locations={locations} />
    </NotFoundView>
  );
}
