import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlaceState } from "@/lib/place-controller";

vi.mock("@/components/ui/spinner", () => ({ Spinner: () => null }));

const { PageWeatherNotice, pageWeatherNoticeKind } =
  await import("./PageWeatherNotice");

const SEED = {
  location: {
    slug: "harare",
    name: "Harare",
    province: "Harare",
    lat: -17.83,
    lon: 31.05,
    elevation: 1490,
    tags: [],
  },
  season: { name: "Dry", localName: "Chirimo", description: "" },
  countryName: "Zimbabwe",
};

function state(patch: Partial<PlaceState>): PlaceState {
  return {
    seed: SEED,
    view: null,
    device: null,
    fetching: false,
    failed: false,
    slow: false,
    trying: false,
    isHome: false,
    path: "/harare",
    ...patch,
  };
}

describe("pageWeatherNoticeKind", () => {
  it("is silent while the forecast is simply on its way", () => {
    expect(pageWeatherNoticeKind(state({ fetching: true }))).toBeNull();
  });

  it("says it is still trying only over a skeleton, never over a stored copy", () => {
    expect(pageWeatherNoticeKind(state({ slow: true }))).toBe("slow");
    expect(
      pageWeatherNoticeKind(
        state({ slow: true, view: {} as PlaceState["view"] }),
      ),
    ).toBeNull();
  });

  it("the final 'could not load' wins over the 'still trying' line", () => {
    expect(pageWeatherNoticeKind(state({ failed: true, slow: true }))).toBe(
      "failed",
    );
  });

  it("also tells a visitor looking at a stored copy that it could not be refreshed", () => {
    expect(
      pageWeatherNoticeKind(
        state({ failed: true, view: {} as PlaceState["view"] }),
      ),
    ).toBe("failed");
  });
});

describe("PageWeatherNotice", () => {
  const retry = () => {};

  it("renders nothing when there is nothing to say", () => {
    expect(
      renderToString(
        createElement(PageWeatherNotice, { state: state({}), retry }),
      ),
    ).toBe("");
  });

  it("is the calm status line, with a Try again that is a request", () => {
    const html = renderToString(
      createElement(PageWeatherNotice, { state: state({ slow: true }), retry }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Still trying to reach the weather service");
    expect(html).toContain("Try again");
    expect(html).not.toContain('role="alert"');
  });

  it("shows 'Trying…' while the attempt the visitor started is in flight", () => {
    const html = renderToString(
      createElement(PageWeatherNotice, {
        state: state({ slow: true, trying: true }),
        retry,
      }),
    );
    expect(html).toContain("Trying…");
    expect(html).toContain("disabled");
  });

  it("is an alert once the retries are spent, naming the place", () => {
    const html = renderToString(
      createElement(PageWeatherNotice, {
        state: state({ failed: true }),
        retry,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Harare");
  });

  it("floats in the shared column above the mobile nav, never in the page flow", () => {
    const source = readFileSync(
      resolve(__dirname, "PageWeatherNotice.tsx"),
      "utf-8",
    );
    expect(source).toContain("<FloatingStack>");
    expect(source).not.toMatch(/style=\{\{|#[0-9a-fA-F]{3,8}\b/);
    expect(source).toContain('key="failed"');
    expect(source).toContain('key="slow"');
  });
});
