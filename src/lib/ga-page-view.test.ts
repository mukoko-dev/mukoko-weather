import { describe, it, expect, vi } from "vitest";
import { pageHitFields, sendSanitisedPageView } from "./ga-page-view";

const env = {
  origin: "https://weather.mukoko.com",
  pathname: "/west-paddock--ksy4dd7/forecast",
  search: "?lat=-17.83123&lon=31.04987&utm_source=wa&gclid=abc",
  title: "Weather in West Paddock",
  referrer: "https://weather.mukoko.com/other--ksy4dd7?lat=-17.8312",
};

describe("pageHitFields", () => {
  it("coarsens the slug, hides the title, keeps attribution only", () => {
    const f = pageHitFields(env);
    expect(f.page_path).toBe("/spot--ksy4/forecast");
    expect(f.page_location).toBe(
      "https://weather.mukoko.com/spot--ksy4/forecast?utm_source=wa&gclid=abc",
    );
    expect(f.page_title).toBe("mukoko weather");
    expect(f.page_referrer).toBe("https://weather.mukoko.com/spot--ksy4");
    expect(JSON.stringify(f)).not.toMatch(/ksy4dd7|17\.83|West Paddock/);
  });
  it("leaves a catalog page and its title alone", () => {
    const f = pageHitFields({
      ...env,
      pathname: "/harare",
      search: "",
      title: "Harare weather",
      referrer: "",
    });
    expect(f.page_path).toBe("/harare");
    expect(f.page_title).toBe("Harare weather");
  });
});

describe("sendSanitisedPageView", () => {
  it("sets the page fields (applies to every later hit) before page_view", () => {
    const gtag = vi.fn();
    sendSanitisedPageView(gtag, env);
    expect(gtag.mock.calls[0][0]).toBe("set");
    expect(gtag.mock.calls[0][1]).toMatchObject({
      page_title: "mukoko weather",
    });
    expect(gtag.mock.calls[1][0]).toBe("event");
    expect(gtag.mock.calls[1][1]).toBe("page_view");
  });
});
