import { describe, it, expect } from "vitest";
import { SITE_URL } from "@/lib/site";
import { buildPageMetadata, LOCATION_NOT_FOUND_TITLE } from "./metadata";

const base = {
  title: "Harare 7-Day Forecast",
  description: "Forecast for Harare.",
  path: "/harare/forecast",
  keywords: ["harare forecast"],
  og: { title: "Harare Forecast | mukoko weather", description: "OG text" },
};

describe("buildPageMetadata", () => {
  it("uses SITE_URL + path for canonical and og:url", () => {
    const m = buildPageMetadata(base);
    expect(m.alternates?.canonical).toBe(`${SITE_URL}/harare/forecast`);
    expect((m.openGraph as { url: string }).url).toBe(
      `${SITE_URL}/harare/forecast`,
    );
  });

  it("emits the open graph shape the location pages share", () => {
    const m = buildPageMetadata(base);
    expect(m.openGraph).toEqual({
      title: "Harare Forecast | mukoko weather",
      description: "OG text",
      url: `${SITE_URL}/harare/forecast`,
      type: "website",
      locale: "en",
      siteName: "mukoko weather",
    });
  });

  it("omits images and twitter when not given (forecast, atmosphere, map, agriculture)", () => {
    const m = buildPageMetadata(base);
    expect(m.twitter).toBeUndefined();
    expect((m.openGraph as Record<string, unknown>).images).toBeUndefined();
    expect(m.title).toBe(base.title);
    expect(m.description).toBe(base.description);
    expect(m.keywords).toEqual(base.keywords);
  });

  it("adds the og image and the summary_large_image twitter card when given", () => {
    const image = {
      url: `${SITE_URL}/api/og?x=1`,
      width: 1200,
      height: 630,
      alt: "Harare weather forecast",
    };
    const m = buildPageMetadata({
      ...base,
      og: { ...base.og, image },
      twitter: {
        title: "T",
        description: "D",
        images: [image.url],
      },
    });
    expect((m.openGraph as { images: unknown[] }).images).toEqual([image]);
    expect(m.twitter).toEqual({
      card: "summary_large_image",
      title: "T",
      description: "D",
      images: [image.url],
    });
  });

  it("answers an unknown slug with the shared not-found title only", () => {
    expect(buildPageMetadata({ notFound: true })).toEqual({
      title: LOCATION_NOT_FOUND_TITLE,
    });
    expect(LOCATION_NOT_FOUND_TITLE).toBe("Location not found");
  });
});
