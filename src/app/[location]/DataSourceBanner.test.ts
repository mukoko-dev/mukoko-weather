import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CURRENT_SOURCES } from "@/lib/forecast-sources";
import { DataSourceBanner } from "./DataSourceBanner";

const render = (source: string | null | undefined, className?: string) =>
  renderToStaticMarkup(createElement(DataSourceBanner, { source, className }));

describe("DataSourceBanner (the NEA notice, as an alert banner)", () => {
  const html = render("nea");
  const nea = CURRENT_SOURCES.nea;

  it("says the licence's own words, with the link to the licence", () => {
    // The whole statement, text and link: what the licence asks for. React
    // writes an apostrophe as a character reference; nothing else in it moves.
    const inMarkup = (text: string) => text.replace(/'/g, "&#x27;");
    expect(html).toContain(inMarkup(nea.before));
    expect(html).toContain(`>${nea.linkText}</a>${nea.after}</li>`);
    expect(html).toContain(`href="${nea.href}"`);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("is an information banner with a close button a screen reader can name", () => {
    expect(html).toContain('data-banner="source:nea"');
    expect(html).toContain('aria-label="Dismiss data source notice"');
    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-[var(--touch-target-min)]");
    expect(html).toContain("pr-12");
  });

  it("draws nothing for a source with no credit due, or none at all", () => {
    expect(render("some-other-source")).toBe("");
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("leaves a gap below it unless the page spaces its stack itself", () => {
    expect(html).toContain("mb-6");
    expect(render("nea", "")).not.toContain("mb-6");
  });
});
