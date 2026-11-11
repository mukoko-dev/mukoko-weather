/**
 * LayerCapacityNote (#542): the line in the map sheet that says a live layer is
 * busy and a working one is showing instead. Rendered for real
 * (react-dom/server), like MapPreview's test, so these check the HTML a visitor
 * gets: the words, the status role, the retry control and its states.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LayerCapacityNote } from "./LayerCapacityNote";

function render(
  props: Partial<Parameters<typeof LayerCapacityNote>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(LayerCapacityNote, {
      layerId: "precipitationIntensity",
      fallbackLabel: "Satellite",
      rechecking: false,
      onRetry: () => {},
      ...props,
    }),
  );
}

describe("LayerCapacityNote", () => {
  it("says plainly that live rain is busy and that satellite is showing", () => {
    const html = render();
    expect(html).toContain(
      "Live rain radar is busy right now. Showing satellite instead.",
    );
  });

  it("names the layer the person chose", () => {
    expect(render({ layerId: "temperature" })).toContain(
      "Live temperature map is busy right now.",
    );
    expect(render({ layerId: "windSpeed" })).toContain("Live wind map is busy");
    expect(render({ layerId: "cloudCover" })).toContain(
      "Live cloud map is busy",
    );
  });

  it("is a status line (read out politely once), not an alert", () => {
    const html = render();
    expect(html).toMatch(/<p[^>]*role="status"/);
    expect(html).not.toContain('role="alert"');
  });

  it("offers one tap to try again, named for the layer, with the words inside the name", () => {
    const html = render();
    const button = html.match(/<button[^>]*>/)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label="Try again: live rain radar"');
    expect(button).not.toContain("disabled");
    expect(html).toContain(">Try again</button>");
  });

  it("shows 'Checking…' and cannot be tapped again while its one request is out", () => {
    const html = render({ rechecking: true });
    const button = html.match(/<button[^>]*>/)?.[0] ?? "";
    expect(button).toContain("disabled");
    expect(button).toContain('aria-busy="true"');
    expect(html).toContain(">Checking…</button>");
    expect(html).not.toContain("Try again");
  });

  it("uses Mzizi tokens and the pill control class, not hand-rolled sizes or colours", () => {
    const html = render();
    // .impala-sm is the outline pill with the 49 px minimum height.
    expect(html).toContain("impala-sm");
    expect(html).toContain("gap-[var(--gap-floor)]");
    expect(html).toContain("text-text-primary");
    expect(html).not.toMatch(/\d+px/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toContain("style=");
  });

  it("blames no one and shows no code", () => {
    const text = render().replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/error|failed|quota|\b429\b|\b503\b|tomorrow/i);
  });
});
