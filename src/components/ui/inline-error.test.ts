import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineError } from "./inline-error";

describe("InlineError", () => {
  it("renders the message in an alert region", () => {
    const html = renderToStaticMarkup(
      createElement(InlineError, { message: "Couldn't load." }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t load.");
    expect(html).not.toContain("<button");
  });

  it("adds a 48px-target retry button when onRetry is given", () => {
    const html = renderToStaticMarkup(
      createElement(InlineError, { message: "x", onRetry: () => {} }),
    );
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("impala-sm");
    expect(html).toContain("Try again");
  });
});

describe("InlineError quiet tone", () => {
  it("renders a neutral acacia card that is still an alert region", () => {
    const html = renderToStaticMarkup(
      createElement(InlineError, {
        message: "Unable to display Hourly.",
        tone: "quiet",
        onRetry: () => {},
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("acacia");
    expect(html).toContain("dikdik mt-2");
    expect(html).not.toContain("alert-edge");
  });
});
