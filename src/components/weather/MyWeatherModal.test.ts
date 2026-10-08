/**
 * Tests for MyWeatherModal — source-level structure checks in the repo's
 * style. They pin the contract that matters for data safety: closing cancels,
 * only the primary button commits, search selects (does not save), the modal
 * opens on the location view with search visible, and the current slug is
 * never a hardcoded city or a path with slashes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "MyWeatherModal.tsx"), "utf-8");

/** Body of a named function declaration, up to the next top-level declaration. */
function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\n// ──", start);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("MyWeatherModal — current location", () => {
  it("derives the current slug via the shared helper", () => {
    expect(source).toContain("currentLocationSlug,");
    expect(source).toContain('} from "@/lib/current-slug";');
    expect(source).toContain(
      "const currentSlug = currentLocationSlug(pathname, selectedLocation);",
    );
  });

  it("never splits the path with replace() and never falls back to harare", () => {
    expect(source).not.toContain('pathname?.replace("/", "")');
    expect(source).not.toContain('"harare"');
  });
});

describe("MyWeatherModal — close cancels, primary button commits", () => {
  const modal = bodyOf("MyWeatherModal");

  it("closing (onOpenChange false) only calls handleCancel", () => {
    expect(modal).toMatch(/if \(!open\) handleCancel\(\);/);
  });

  it("cancel closes without writing anything", () => {
    const cancel = modal.slice(
      modal.indexOf("const handleCancel"),
      modal.indexOf("const handleApply"),
    );
    expect(cancel).toContain("closeMyWeather()");
    expect(cancel).not.toContain("completeOnboarding");
    expect(cancel).not.toContain("setSelectedLocation");
    expect(cancel).not.toContain("router.push");
  });

  it("apply is the only place that commits onboarding, location and navigation", () => {
    const apply = modal.slice(modal.indexOf("const handleApply"));
    expect(apply).toContain("completeOnboarding()");
    expect(apply).toContain("setSelectedLocation(pendingSlug)");
    expect(apply).toContain("router.push(`/${pendingSlug}`)");
  });

  it("primary button label is Apply only when there is a pending change", () => {
    expect(source).toContain(
      "const hasPendingChange = pending !== null && pending.slug !== currentSlug;",
    );
    expect(source).toContain('{hasPendingChange ? "Apply" : "Done"}');
  });
});

describe("MyWeatherModal — selection rules", () => {
  it("selectLocation validates the slug and only sets pending", () => {
    const select = source.slice(
      source.indexOf("const selectLocation"),
      source.indexOf("/** Close without writing anything"),
    );
    expect(select).toContain("if (!isLocationSlug(slug)) return;");
    expect(select).toContain("setPending({ slug, method });");
    expect(select).not.toContain("saveLocation");
  });

  it("search results select on tap and save only through the explicit Save button", () => {
    const saved = bodyOf("SavedTab");
    expect(saved).toContain('onSelectLocation(loc.slug, "search");');
    expect(saved).toContain("saveLocation(loc.slug);");
    // The row itself must not save
    const row = saved.slice(
      saved.indexOf('onSelectLocation(loc.slug, "search");'),
      saved.indexOf("saveLocation(loc.slug);"),
    );
    expect(row).not.toContain("saveLocation");
  });

  it("geolocation selects the detected location without auto-saving it", () => {
    const saved = bodyOf("SavedTab");
    const geo = saved.slice(
      saved.indexOf("const handleGeolocate"),
      saved.indexOf("const handleSaveLabel"),
    );
    expect(geo).toContain(
      'onSelectLocation(result.location.slug, "geolocation")',
    );
    expect(geo).not.toContain("saveLocation");
  });
});

describe("MyWeatherModal — opens on the location view", () => {
  it("defaults to the location tab, with search rendered before the saved list", () => {
    expect(source).toContain("useState<MyWeatherTab>(initialTab)");
    expect(source).toContain(
      '<TabsTrigger value="location">Location</TabsTrigger>',
    );
    const searchAt = source.indexOf('placeholder="Search for a location..."');
    const savedAt = source.indexOf('aria-label="Saved locations"');
    expect(searchAt).toBeGreaterThan(-1);
    expect(savedAt).toBeGreaterThan(searchAt);
  });

  it("no longer hides search behind an add-location toggle", () => {
    expect(source).not.toContain("+ Add location");
    expect(source).not.toContain("showAdd");
  });

  it("autofocuses search only on fine pointers (no keyboard pop on touch)", () => {
    expect(source).toContain('window.matchMedia("(pointer: fine)")');
  });
});

describe("MyWeatherModal — opening tab", () => {
  it("reads the requested tab from the store and uses the same ids as the tab triggers", () => {
    expect(source).toContain("useAppStore((s) => s.myWeatherTab)");
    expect(source).toContain('<TabsTrigger value="activities">');
    expect(source).toContain('<TabsTrigger value="settings">');
  });
});

describe("MyWeatherModal — analytics", () => {
  it("keeps location_changed and modal_opened events", () => {
    expect(source).toContain('trackEvent("location_changed"');
    expect(source).toContain('trackEvent("modal_opened"');
  });
});

describe("MyWeatherModal — names", () => {
  it("prefers the result's own name and remembers it for the session", () => {
    const saved = bodyOf("SavedTab");
    expect(saved).toContain("rememberLocationName(loc.slug, loc.name);");
    expect(saved).toContain(
      "rememberLocationName(result.location.slug, result.location.name);",
    );
  });

  it("falls back to a slug name that strips the platform hash", () => {
    expect(source).toContain(
      "locationNames[slug] ?? displayNameFromSlug(slug)",
    );
    expect(source).not.toContain("slugToDisplayName");
  });
});

describe("MyWeatherModal — current location row", () => {
  it("shows the viewed location as Current when it is not saved", () => {
    const saved = bodyOf("SavedTab");
    expect(saved).toContain(
      "currentSlug && !savedLocations.includes(currentSlug)",
    );
    expect(saved).toContain(">\n            Current\n");
    expect(source).toContain("currentSlug={currentSlug}");
  });
});
