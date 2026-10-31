import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoadingNotice } from "./loading-notice";

describe("LoadingNotice", () => {
  it("is a polite status region carrying the visible label", () => {
    const html = renderToStaticMarkup(
      createElement(LoadingNotice, { label: "Loading map…" }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading map…");
    expect(html).toContain("animate-spin");
  });
});
