import { describe, expect, it } from "vitest";
import { isSameOrigin } from "./same-origin";

const req = (url: string, origin?: string) =>
  new Request(url, { method: "POST", headers: origin ? { origin } : {} });

describe("isSameOrigin", () => {
  it("accepts this site's own origin", () => {
    expect(
      isSameOrigin(
        req(
          "https://weather.mukoko.com/auth/signout",
          "https://weather.mukoko.com",
        ),
      ),
    ).toBe(true);
  });

  it("refuses another site, another port, a missing or null origin and garbage", () => {
    const url = "https://weather.mukoko.com/auth/signout";
    expect(isSameOrigin(req(url, "https://evil.example"))).toBe(false);
    expect(isSameOrigin(req(url, "https://weather.mukoko.com:8443"))).toBe(
      false,
    );
    expect(isSameOrigin(req(url, "http://weather.mukoko.com"))).toBe(false);
    expect(isSameOrigin(req(url))).toBe(false);
    expect(isSameOrigin(req(url, "null"))).toBe(false);
  });
});
