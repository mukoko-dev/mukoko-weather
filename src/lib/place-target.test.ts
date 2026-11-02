import { describe, expect, it } from "vitest";
import {
  pathOfTarget,
  placeDocumentTitle,
  placeTargetOf,
} from "./place-target";

describe("placeTargetOf", () => {
  it("names the home place and single-segment place URLs", () => {
    expect(placeTargetOf("/")).toEqual({ kind: "home" });
    expect(placeTargetOf("/harare")).toEqual({ kind: "slug", slug: "harare" });
    expect(placeTargetOf("/nairobi-ke/")).toEqual({
      kind: "slug",
      slug: "nairobi-ke",
    });
    expect(placeTargetOf("/koh-samui--w4gz9k2")).toEqual({
      kind: "slug",
      slug: "koh-samui--w4gz9k2",
    });
  });

  it("leaves every other URL to the router", () => {
    expect(placeTargetOf("/harare/forecast")).toBeNull();
    expect(placeTargetOf("/explore")).toBeNull();
    expect(placeTargetOf("/profile")).toBeNull();
    expect(placeTargetOf("/harare?utm_source=x")).toBeNull();
    expect(placeTargetOf("/harare#top")).toBeNull();
    expect(placeTargetOf("https://weather.mukoko.com/harare")).toBeNull();
    expect(placeTargetOf("//evil.example/harare")).toBeNull();
    expect(placeTargetOf("harare")).toBeNull();
    expect(placeTargetOf("")).toBeNull();
    expect(placeTargetOf(null)).toBeNull();
    expect(placeTargetOf("/%E0%A4%A")).toBeNull();
    expect(placeTargetOf("/Harare")).toBeNull(); // not a canonical slug
  });

  it("round-trips through pathOfTarget", () => {
    expect(pathOfTarget({ kind: "home" })).toBe("/");
    expect(pathOfTarget({ kind: "slug", slug: "harare" })).toBe("/harare");
  });

  it("titles a place like the server's metadata", () => {
    expect(placeDocumentTitle("Harare")).toBe(
      "Harare Weather Today — Forecast & Conditions | mukoko weather",
    );
  });
});
