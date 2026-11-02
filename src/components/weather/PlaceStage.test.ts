import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const stage = readFileSync(resolve(__dirname, "PlaceStage.tsx"), "utf-8");

describe("PlaceStage — what the page waits for and what it shows", () => {
  it("keeps the dashboard's code out of the first-load JavaScript", () => {
    expect(stage).toContain('import("@/app/[location]/WeatherDashboard")');
    expect(stage).toMatch(/dynamic\(loadDashboard, \{\s*ssr: false/);
    // Never imported statically (that would put charts and drag-and-drop in
    // every place page's first load).
    expect(stage).not.toMatch(/^import[^;]*WeatherDashboard[^;]*;/m);
    // The chunk starts loading at mount, in parallel with the device read and
    // the visitor's forecast request, and a failure to fetch it is handled.
    expect(stage).toContain("void loadDashboard().catch(() => {});");
    expect(stage).toContain('<ChartErrorBoundary name="weather dashboard">');
  });

  it("renders the skeleton, with a heading, until a view exists", () => {
    expect(stage).toContain("<LocationSkeleton slug={seed.location.slug} />");
    expect(stage).toContain('<h1 className="sr-only">');
    expect(stage).toContain("view ? (");
  });

  it("never renders weather it did not get from memory, the device or the visitor's own request", () => {
    expect(stage).toContain("fetchHomeWeather(lat, lon, signal)");
    expect(stage).toContain("recallPlace(slug)");
    expect(stage).not.toContain("createFallbackWeather");
  });

  it("follows the pathname with the router, never a page reload", () => {
    expect(stage).toContain("controller.reconcile(pathname)");
    expect(stage).toContain("router.replace(pathname)");
    expect(stage).not.toContain("location.reload");
  });

  it("pushes the URL with history.pushState (Next's documented shallow routing)", () => {
    expect(stage).toContain('window.history.pushState(null, "", path)');
    expect(stage).toContain('window.history.replaceState(null, "", path)');
  });

  it("remembers the place for the next visit, and fixes the tab title, on every show", () => {
    expect(stage).toContain("if (!isHome) writeLastLocationCookie(slug);");
    expect(stage).toContain("document.title = placeDocumentTitle(");
    expect(stage).toContain("useAppStore.getState().setSelectedLocation(slug)");
  });

  it("registers with the switch bus while mounted and unregisters on unmount", () => {
    expect(stage).toContain("registerPlaceStage({");
    expect(stage).toContain("unregister();");
    expect(stage).toContain('controller.showTarget(target, "push")');
  });
});

describe("PlaceLoadNotice", () => {
  vi.mock("@/components/ui/spinner", () => ({ Spinner: () => null }));

  it("says what happened and offers a retry that is a request", async () => {
    const { PlaceLoadNotice } = await import("./PlaceLoadNotice");
    const html = renderToString(
      createElement(PlaceLoadNotice, {
        placeName: "Harare",
        showingSaved: false,
        busy: false,
        onRetry: () => {},
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t load the weather for Harare.");
    expect(html).toContain("Try again");
  });

  it("says when the weather on screen is the copy saved on the device", async () => {
    const { PlaceLoadNotice } = await import("./PlaceLoadNotice");
    const html = renderToString(
      createElement(PlaceLoadNotice, {
        placeName: "Harare",
        showingSaved: true,
        busy: true,
        onRetry: () => {},
      }),
    );
    expect(html).toContain("Showing what is saved on this device");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Trying");
  });
});
