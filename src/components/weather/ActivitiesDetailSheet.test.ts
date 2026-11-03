/**
 * ActivitiesDetailSheet + the Community lane entry point: the long
 * "My Activities" section lives behind the lane as a sheet, like the
 * Conditions tiles' detail. Source checks for structure, react-dom/server
 * renders for what the lane's HTML actually contains.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFallbackWeather } from "@/lib/weather";
import { CommunityLane } from "./CommunityLane";
import { CardHitArea } from "@/components/ui/card-hit-area";
import { activityCardAnchorId } from "./ActivityCard";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../..", rel), "utf-8");

const sheet = read("src/components/weather/ActivitiesDetailSheet.tsx");
const detailSheet = read("src/components/ui/detail-sheet.tsx");
const lane = read("src/components/weather/CommunityLane.tsx");
const insights = read("src/components/weather/ActivityInsights.tsx");
const metricModal = read("src/components/weather/MetricDetailModal.tsx");

describe("ActivitiesDetailSheet structure", () => {
  it("is the shared DetailSheet titled 'My activities'", () => {
    expect(sheet).toContain('"use client"');
    expect(sheet).toContain("export function ActivitiesDetailSheet(");
    expect(sheet).toContain("<DetailSheet");
    expect(sheet).toContain('title="My activities"');
  });

  it("shows the per-activity cards and the Edit action, isolated", () => {
    expect(sheet).toContain("<ActivityInsights");
    expect(sheet).toContain("ChartErrorBoundary");
    expect(sheet).toContain("ActivityInsightsSkeleton");
    // Edit closes the sheet first, then opens My Weather's activities tab.
    expect(sheet).toMatch(
      /onEdit=\{\(\) => \{\s*onClose\(\);\s*openMyWeather\("activities"\);/,
    );
  });

  it("tracks modal_opened and scrolls to the tapped activity honouring reduced motion", () => {
    expect(sheet).toContain(
      'trackEvent("modal_opened", { modal: "activities" })',
    );
    expect(sheet).toContain("getScrollBehavior()");
    expect(sheet).toContain("activityCardAnchorId(focusActivityId)");
    expect(sheet).toContain("card.focus({ preventScroll: true })");
  });

  it("uses tokens only, no inline styles or colours", () => {
    for (const src of [sheet, detailSheet, lane]) {
      expect(src).not.toMatch(/style=\{\{/);
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe("DetailSheet (one scaffold for both sheets)", () => {
  it("is built on the shared Dialog: handle, title, description, Close", () => {
    expect(detailSheet).toContain('from "@/components/ui/dialog"');
    expect(detailSheet).toContain("<DialogSheetHandle />");
    expect(detailSheet).toContain("<DialogTitle");
    expect(detailSheet).toContain("<DialogDescription");
    expect(detailSheet).toContain("Close");
  });

  it("can return focus to a given opener (Safari does not focus buttons on tap)", () => {
    expect(detailSheet).toContain("returnFocusTo");
    expect(detailSheet).toContain("onCloseAutoFocus");
  });

  it("is used by both the metric tiles and the activities sheet, and nobody else writes the scaffold", () => {
    expect(metricModal).toContain("<DetailSheet");
    expect(sheet).toContain("<DetailSheet");
    expect(metricModal).not.toContain("<DialogContent");
    expect(sheet).not.toContain("<DialogContent");
  });
});

describe("ActivityInsights split", () => {
  it("exports the small invitation separately for the page", () => {
    expect(insights).toContain("export function ActivityInvite()");
    expect(insights).toContain("Advice for what you do");
    expect(insights).toContain('openMyWeather("activities")');
  });

  it("lets the host replace the Edit action", () => {
    expect(insights).toContain("onEdit");
    expect(insights).toContain("onClick: edit");
  });
});

describe("activity card anchors", () => {
  it("gives every activity a stable, unique id", () => {
    expect(activityCardAnchorId("football")).toBe("activity-card-box-football");
    expect(activityCardAnchorId("football")).not.toBe(
      activityCardAnchorId("barbecue"),
    );
    const card = read("src/components/weather/ActivityCard.tsx");
    expect(card).toContain("id={activityCardAnchorId(activity.id)}");
    expect(card).toContain("tabIndex={-1}");
  });
});

describe("CardHitArea", () => {
  it("renders a labelled, popup-announcing button over its parent", () => {
    const html = renderToStaticMarkup(
      createElement(CardHitArea, { "aria-label": "Open it" }),
    );
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Open it"');
    expect(html).toContain("absolute inset-0");
  });
});

describe("CommunityLane entry point (rendered)", () => {
  const weather = createFallbackWeather(-17.83, 31.05, 1490);
  const render = (withHandler: boolean) =>
    renderToStaticMarkup(
      createElement(CommunityLane, {
        slug: "harare",
        lat: -17.83,
        lon: 31.05,
        weather,
        selectedActivities: ["football", "barbecue"],
        onOpenAdvice: withHandler ? () => {} : undefined,
      }),
    );

  it("lays a full-card hit area, one per activity row, and an 'All advice' action", () => {
    const html = render(true);
    expect(html).toContain('aria-label="Open all activity advice"');
    expect(html).toContain("All advice");
    expect(html).toMatch(
      /aria-label="[^"]*Soccer[^"]*: open advice"|: open advice"/,
    );
    // card + 2 rows are dialog openers, plus the visible text action
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(4);
  });

  it("renders no openers without a handler", () => {
    const html = render(false);
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("All advice");
  });

  it("keeps report pins above the overlay and never nests buttons", () => {
    // Pins are z-10; the card overlay z-[1]; rows z-[2].
    expect(lane).toContain("z-10 flex min-h-[var(--touch-target-min)]");
    expect(lane).toContain('className="z-[2]"');
    expect(lane).toContain("acacia relative z-10");
    expect(lane).toContain("impala-sm relative z-10");
    // The overlays are siblings of the content, not wrappers: the section is
    // not itself a button and no <button> contains another.
    const html = render(true);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  });

  it("the All advice action meets the touch target (impala-sm is 48px)", () => {
    const css = read("src/app/globals.css");
    const block = css.slice(css.indexOf(".impala-sm {"));
    expect(block.slice(0, 600)).toContain("--touch-target-min");
  });
});
