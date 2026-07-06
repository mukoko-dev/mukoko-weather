import { describe, it, expect } from "vitest";
import { initialsFor, displayNameFor } from "./user-display";

describe("initialsFor", () => {
  it("uses first + last initial when both present", () => {
    expect(initialsFor({ firstName: "Bryan", lastName: "Fawcett" })).toBe("BF");
  });

  it("uses first initial only when last name missing", () => {
    expect(initialsFor({ firstName: "Bryan" })).toBe("B");
  });

  it("uses last initial only when first name missing", () => {
    expect(initialsFor({ lastName: "Fawcett" })).toBe("F");
  });

  it("falls back to email initial when no name present", () => {
    expect(initialsFor({ email: "bryan@nyuchi.com" })).toBe("B");
  });

  it("falls back to '?' when nothing is present", () => {
    expect(initialsFor({})).toBe("?");
  });

  it("trims whitespace-only names before falling back", () => {
    expect(
      initialsFor({ firstName: "  ", lastName: "  ", email: "a@b.com" }),
    ).toBe("A");
  });
});

describe("displayNameFor", () => {
  it("joins first + last name", () => {
    expect(displayNameFor({ firstName: "Bryan", lastName: "Fawcett" })).toBe(
      "Bryan Fawcett",
    );
  });

  it("falls back to email when no name present", () => {
    expect(displayNameFor({ email: "bryan@nyuchi.com" })).toBe(
      "bryan@nyuchi.com",
    );
  });

  it("falls back to 'Signed in' when nothing is present", () => {
    expect(displayNameFor({})).toBe("Signed in");
  });
});
