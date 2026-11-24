import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WeatherUnavailableBanner } from "./WeatherUnavailableBanner";

describe("WeatherUnavailableBanner can be closed", () => {
  const html = renderToStaticMarkup(createElement(WeatherUnavailableBanner));

  it("has a close button, and still offers Try again", () => {
    expect(html).toContain('aria-label="Dismiss weather notice"');
    expect(html).toContain("Try again");
  });

  it("stays a polite status, not an alert, and leaves room for the button", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("pr-12");
  });

  it("leaves a gap below it unless the page spaces its stack itself", () => {
    expect(html).toContain("mb-6");
    const stacked = renderToStaticMarkup(
      createElement(WeatherUnavailableBanner, { className: "" }),
    );
    expect(stacked).not.toContain("mb-6");
  });
});
