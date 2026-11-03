import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LogOut, MapPin } from "lucide-react";
import { GroupedRow } from "./GroupedRow";

const render = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el);

describe("GroupedRow", () => {
  it("renders a link row with the label and a chevron by default", () => {
    const html = render(
      createElement(GroupedRow, {
        icon: MapPin,
        label: "Saved locations",
        href: "/locations",
      }),
    );
    expect(html).toContain("<a ");
    expect(html).toContain('href="/locations"');
    expect(html).toContain("guineafowl-row");
    expect(html).toContain("Saved locations");
    expect(html).toContain("lucide-chevron-right");
  });

  it("renders a button row when given onClick", () => {
    const html = render(
      createElement(GroupedRow, {
        icon: MapPin,
        label: "My Weather",
        onClick: () => undefined,
      }),
    );
    expect(html).toContain('<button type="button" class="guineafowl-row"');
    expect(html).not.toContain("<a ");
  });

  it("shows the value before the chevron", () => {
    const html = render(
      createElement(GroupedRow, {
        icon: MapPin,
        label: "My Weather",
        value: "2 places",
        onClick: () => undefined,
      }),
    );
    expect(html.indexOf("2 places")).toBeLessThan(
      html.indexOf("lucide-chevron-right"),
    );
  });

  it("drops the chevron when asked, and colours a danger row", () => {
    const html = render(
      createElement(GroupedRow, {
        icon: LogOut,
        label: "Sign out",
        href: "/auth/signout",
        tone: "danger",
        chevron: false,
      }),
    );
    expect(html).toContain("text-severity-severe");
    expect(html).not.toContain("lucide-chevron-right");
  });

  it("adds a screen-reader description without showing it", () => {
    const html = render(
      createElement(GroupedRow, {
        icon: MapPin,
        label: "Explore",
        description: "Browse places by category",
        href: "/explore",
      }),
    );
    expect(html).toContain(
      '<span class="sr-only">Browse places by category</span>',
    );
  });
});
