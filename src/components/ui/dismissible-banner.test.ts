import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DismissibleBanner } from "./dismissible-banner";

const source = readFileSync(
  resolve(__dirname, "dismissible-banner.tsx"),
  "utf8",
);

const html = renderToStaticMarkup(
  createElement(DismissibleBanner, {
    id: "frost:high:cold",
    closeLabel: "Dismiss frost advisory",
    children: createElement("p", null, "Frost tonight"),
  }),
);

describe("DismissibleBanner", () => {
  it("shows the alert on the server and on the first client render (the memory is not known there)", () => {
    expect(html).toContain("Frost tonight");
    expect(html).toContain('data-banner="frost:high:cold"');
    expect(source).toContain("() => false,");
  });

  it("has a close button a screen reader can name, and that is a full touch target", () => {
    expect(html).toMatch(
      /<button type="button" aria-label="Dismiss frost advisory"/,
    );
    expect(html).toContain("min-h-[var(--touch-target-min)]");
    expect(html).toContain("min-w-[var(--touch-target-min)]");
    // The glyph is decoration.
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("sits on a solid card so it reads on the sky and on the page alike", () => {
    expect(html).toContain("bg-surface-card");
    expect(html).toContain("rounded-[var(--radius-card)]");
  });

  it("closes through the shared memory and renders nothing once closed", () => {
    expect(source).toContain("closeBanner(id, remember)");
    expect(source).toContain("if (isClosed) return null;");
    expect(source).toContain("useSyncExternalStore");
  });
});
