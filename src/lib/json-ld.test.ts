import { describe, it, expect } from "vitest";
import { SITE_URL } from "@/lib/site";
import { breadcrumbJsonLd, safeJsonLd } from "./json-ld";

describe("safeJsonLd", () => {
  it("produces JSON that parses back to the original value", () => {
    const data = {
      name: "Harare",
      province: "Harare Metropolitan",
      tags: ["city"],
    };
    expect(JSON.parse(safeJsonLd(data))).toEqual(data);
  });

  it("escapes < and > so a </script> payload cannot break out of the tag", () => {
    const malicious = { name: "</script><script>alert(1)</script>" };
    const out = safeJsonLd(malicious);
    // The raw closing tag must not appear verbatim in the serialized output.
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u003e");
    // ...but it still round-trips to the exact original string.
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });

  it("escapes ampersands", () => {
    const out = safeJsonLd({ name: "Dar & Salaam" });
    expect(out).not.toContain(" & ");
    expect(out).toContain("\\u0026");
    expect(JSON.parse(out).name).toBe("Dar & Salaam");
  });

  it("escapes U+2028 and U+2029 line separators", () => {
    const raw = "line1\u2028line2\u2029line3";
    const out = safeJsonLd({ name: raw });
    expect(out).not.toContain("\u2028");
    expect(out).not.toContain("\u2029");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(JSON.parse(out).name).toBe(raw);
  });

  it("handles arrays of schema objects (as used on the location page)", () => {
    const schemas = [{ "@type": "WebPage" }, { "@type": "BreadcrumbList" }];
    expect(JSON.parse(safeJsonLd(schemas))).toEqual(schemas);
  });
});

describe("breadcrumbJsonLd", () => {
  it("puts the SITE_URL root first and numbers the trail from position 2", () => {
    const crumb = breadcrumbJsonLd([
      { name: "Harare Weather", path: "/harare" },
      { name: "Forecast", path: "/harare/forecast" },
    ]);
    expect(crumb).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "mukoko weather",
          item: SITE_URL,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Harare Weather",
          item: `${SITE_URL}/harare`,
        },
        {
          "@type": "ListItem",
          position: 3,
          name: "Forecast",
          item: `${SITE_URL}/harare/forecast`,
        },
      ],
    });
  });

  it("omits item for a crumb with no path, as the province crumb has none", () => {
    const crumb = breadcrumbJsonLd([{ name: "Mashonaland East" }]);
    expect(crumb.itemListElement[1]).toEqual({
      "@type": "ListItem",
      position: 2,
      name: "Mashonaland East",
    });
    expect("item" in crumb.itemListElement[1]).toBe(false);
  });

  it("takes a custom root name and @id for the site-level trail", () => {
    const crumb = breadcrumbJsonLd([], {
      root: "Home",
      id: `${SITE_URL}/#breadcrumb`,
    });
    expect(crumb["@id"]).toBe(`${SITE_URL}/#breadcrumb`);
    expect(crumb.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
    ]);
  });
});
