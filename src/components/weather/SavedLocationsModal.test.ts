/**
 * Tests for SavedLocationsModal — validates the saved locations management
 * modal including search, geolocation, location list, and removal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "SavedLocationsModal.tsx"),
  "utf-8",
);

describe("SavedLocationsModal — component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports SavedLocationsModal as a named export", () => {
    expect(source).toContain("export function SavedLocationsModal");
  });

  it("reads savedLocationsOpen from Zustand store", () => {
    expect(source).toContain("savedLocationsOpen");
    expect(source).toContain("useAppStore");
  });

  it("reads savedLocations array from store", () => {
    expect(source).toContain("s.savedLocations");
  });

  it("imports saveLocation and removeLocation from store", () => {
    expect(source).toContain("s.saveLocation");
    expect(source).toContain("s.removeLocation");
  });

  it("imports MAX_SAVED_LOCATIONS for cap enforcement", () => {
    expect(source).toContain("MAX_SAVED_LOCATIONS");
  });

  it("uses shadcn Dialog component", () => {
    expect(source).toContain("Dialog");
    expect(source).toContain("DialogContent");
    expect(source).toContain("DialogTitle");
  });
});

describe("SavedLocationsModal — icons", () => {
  it("imports icons from weather-icons.tsx (not inline)", () => {
    expect(source).toContain('from "@/lib/weather-icons"');
    expect(source).toContain("TrashIcon");
    expect(source).toContain("PlusIcon");
    expect(source).toContain("NavigationIcon");
  });

  it("does not define icons inline", () => {
    // Should not contain local icon function declarations
    expect(source).not.toMatch(/^function TrashIcon/m);
    expect(source).not.toMatch(/^function PlusIcon/m);
    expect(source).not.toMatch(/^function NavigationIcon/m);
  });
});

describe("SavedLocationsModal — saved locations list", () => {
  it("renders a labeled list for saved locations", () => {
    expect(source).toContain('aria-label="Saved locations"');
  });

  it("uses plain ul/li (no listbox role with nested buttons)", () => {
    // Listbox role is invalid with multiple interactive children per option
    expect(source).not.toContain('role="listbox"');
    expect(source).not.toContain('role="option"');
  });

  it("has a remove button for each location", () => {
    expect(source).toContain("onRemove");
    expect(source).toContain("Remove");
  });

  it("shows empty state when no locations saved", () => {
    expect(source).toContain("No saved locations yet");
  });

  it("shows the count of saved locations", () => {
    expect(source).toContain("savedLocations.length");
    expect(source).toContain("MAX_SAVED_LOCATIONS");
  });

  it("shows loading skeleton while fetching location details", () => {
    expect(source).toContain('aria-label="Loading saved locations"');
    expect(source).toContain("animate-pulse");
  });

  it("tracks loading state for location detail fetch", () => {
    expect(source).toContain("setLoading");
    expect(source).toMatch(/const \[loading, setLoading\]/);
  });
});

describe("SavedLocationsModal — add location search", () => {
  it("has an add location button", () => {
    expect(source).toContain("Add location");
  });

  it("disables add when at capacity", () => {
    expect(source).toContain("atCap");
    expect(source).toContain("disabled={atCap}");
  });

  it("shows limit reached message at capacity", () => {
    expect(source).toContain("Limit reached");
  });

  it("has a search input for finding locations", () => {
    expect(source).toContain("Search locations to add");
  });

  it("imports useDebounce from shared hook", () => {
    expect(source).toContain("useDebounce");
    expect(source).toContain('from "@/lib/use-debounce"');
  });

  it("fetches results from the search API", () => {
    expect(source).toContain("/api/py/search");
  });

  it("filters out already-saved locations from results", () => {
    expect(source).toContain("savedSlugs");
    expect(source).toContain("!savedSlugs.includes");
  });

  it("has a cancel button for search", () => {
    expect(source).toContain("Cancel");
    expect(source).toContain("onCancel");
  });

  it("shows loading skeletons during search", () => {
    expect(source).toContain("animate-pulse");
    expect(source).toContain('role="status"');
  });

  it("shows no results message for empty searches", () => {
    expect(source).toContain("No results for");
  });

  it("renders search results as a labeled list", () => {
    expect(source).toContain('aria-label="Search results"');
  });
});

describe("SavedLocationsModal — current location", () => {
  it("has a current location detection button", () => {
    expect(source).toContain("Current Location");
    expect(source).toContain("detectUserLocation");
  });

  it("shows loading state during geolocation", () => {
    expect(source).toContain("geoLoading");
    expect(source).toContain("Detecting...");
  });

  it("handles geolocation denied", () => {
    expect(source).toContain("denied");
    expect(source).toContain("Location access denied");
  });

  it("handles outside-supported region", () => {
    expect(source).toContain("outside-supported");
    expect(source).toContain("isn&apos;t supported yet");
  });

  it("allows saving detected location", () => {
    expect(source).toContain("Save detected location");
    expect(source).toContain("onSave");
  });
});

describe("SavedLocationsModal — navigation", () => {
  it("navigates to selected location", () => {
    expect(source).toContain("router.push");
    expect(source).toContain("handleSelectLocation");
  });

  it("sets selectedLocation in store on selection", () => {
    expect(source).toContain("setSelectedLocation");
  });

  it("calls completeOnboarding on selection", () => {
    expect(source).toContain("completeOnboarding");
  });

  it("closes modal on selection", () => {
    expect(source).toContain("closeSavedLocations");
  });

  it("has a Done button", () => {
    expect(source).toContain("Done");
  });
});

describe("SavedLocationsModal — HTML validity", () => {
  it("does not nest buttons (CurrentLocationButton uses sibling elements)", () => {
    // Detect the pattern: geolocation button and save button should be siblings
    // inside a flex container, not parent-child
    const buttonMatches = source.match(/<button[\s\S]*?<\/button>/g) || [];
    // No button's innerHTML should contain another <button>
    for (const match of buttonMatches) {
      const innerButtons = (match.match(/<button/g) || []).length;
      expect(innerButtons).toBeLessThanOrEqual(1);
    }
  });

  it("cleans up setTimeout in AddLocationSearch focus effect", () => {
    expect(source).toContain("clearTimeout");
  });
});

describe("SavedLocationsModal — custom labels", () => {
  it("reads locationLabels from store", () => {
    expect(source).toContain("locationLabels");
    expect(source).toContain("s.locationLabels");
  });

  it("reads setLocationLabel from store", () => {
    expect(source).toContain("setLocationLabel");
    expect(source).toContain("s.setLocationLabel");
  });

  it("shows Add label prompt for unlabeled locations", () => {
    expect(source).toContain("Add label");
  });

  it("tracks editing state for inline label input", () => {
    expect(source).toContain("editingSlug");
    expect(source).toContain("editValue");
  });

  it("saves label on Enter key", () => {
    expect(source).toContain("Enter");
    expect(source).toContain("setLocationLabel");
  });

  it("cancels editing on Escape key", () => {
    expect(source).toContain("Escape");
    expect(source).toContain("setEditingSlug(null)");
  });
});

describe("SavedLocationsModal — accessibility", () => {
  it("uses minimum 44px touch targets", () => {
    expect(source).toContain("min-h-[44px]");
  });

  it("has aria-labels on interactive elements", () => {
    expect(source).toContain("aria-label");
  });

  it("marks decorative elements as aria-hidden", () => {
    expect(source).toContain('aria-hidden="true"');
  });

  it("has sr-only loading text for skeletons", () => {
    expect(source).toContain("sr-only");
    expect(source).toContain("Loading");
  });
});
