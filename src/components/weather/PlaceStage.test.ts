import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/spinner", () => ({ Spinner: () => null }));

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
    // Through the shared Worker read (worker-data.ts), never a raw fetchWorker.
    expect(stage).toContain("fetchHomeWeather(lat, lon)");
    expect(stage).not.toContain("fetchWorker");
    expect(stage).toContain('workerData.invalidate("weather", { lat, lon })');
    expect(stage).toContain("recallPlace(slug)");
    expect(stage).not.toContain("createFallbackWeather");
  });

  it("a place switch makes no raw fetchWorker call anywhere on its path", () => {
    // Every file a switch runs through: the stage, its state machine, the bus,
    // the target parser, the slug lookup, the home page client and the pager.
    const dir = resolve(__dirname, "../..");
    for (const file of [
      "components/weather/PlaceStage.tsx",
      "components/weather/PlaceLoadNotice.tsx",
      "lib/place-controller.ts",
      "lib/place-bus.ts",
      "lib/place-target.ts",
      "lib/place-resolve.ts",
      "app/CurrentLocationHome.tsx",
      "components/layout/LocationPager.tsx",
    ]) {
      const source = readFileSync(resolve(dir, file), "utf-8");
      expect(source, file).not.toContain("fetchWorker");
    }
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

describe("PlaceView: the slow-forecast line", () => {
  it("shows the line only over the skeleton, while the retries run, never over the failed notice", () => {
    expect(stage).toContain("state.slow && !view && !state.failed");
    // The final "Couldn't load" notice is unchanged and keyed on `failed`.
    expect(stage).toMatch(/\{state\.failed && \(\s*<PlaceLoadNotice/);
  });

  it("offers the same retry (a forced read, not a reload) from the line", () => {
    const slowBlock = stage.slice(stage.indexOf("state.slow && !view"));
    expect(slowBlock).toContain("onRetry={retry}");
    expect(stage).toContain("controller.retry()");
    expect(stage).not.toContain("location.reload");
  });

  it("leaves the skeleton as it is: the line floats over it, nothing is added to the flow", () => {
    expect(stage).toContain("<LocationSkeleton slug={seed.location.slug} />");
    const notice = readFileSync(
      resolve(__dirname, "PlaceLoadNotice.tsx"),
      "utf-8",
    );
    expect(notice).toContain("fixed inset-x-3");
  });
});

describe("PlaceLoadNotice", () => {
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
  it("slow: a calm polite status line with Try again available at once, not an alert", async () => {
    const { PlaceLoadNotice } = await import("./PlaceLoadNotice");
    const html = renderToString(
      createElement(PlaceLoadNotice, {
        slow: true,
        placeName: "Lagos",
        showingSaved: false,
        busy: false,
        onRetry: () => {},
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Still trying to reach the weather service…");
    expect(html).not.toContain("Couldn&#x27;t load");
    expect(html).toContain("Try again");
    // The button is usable now: the retries are running, not the button's.
    expect(html).not.toContain("disabled");
  });

  it("slow and failed are different notices of the same card, in tokens only", async () => {
    const source = readFileSync(
      resolve(__dirname, "PlaceLoadNotice.tsx"),
      "utf-8",
    );
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("style={{");
    expect(source).toContain("Still trying to reach the weather service…");
    expect(source).toContain('slow ? "status" : "alert"');
  });
});
