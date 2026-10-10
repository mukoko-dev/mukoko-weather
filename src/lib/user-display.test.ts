import { describe, it, expect } from "vitest";
import {
  initialsFor,
  displayNameFor,
  isValidImageUrl,
  sanitizeProfileName,
  MAX_PROFILE_NAME_LENGTH,
  capabilitiesForRole,
  CAPABILITY_LABELS,
  roleLabel,
} from "./user-display";

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

describe("isValidImageUrl", () => {
  it("accepts https, http and in-app paths", () => {
    expect(isValidImageUrl("https://profile-images.mukoko.com/a.jpg")).toBe(
      true,
    );
    expect(isValidImageUrl("http://example.com/a.png")).toBe(true);
    expect(isValidImageUrl("/icon-192.png")).toBe(true);
  });

  it("rejects empty, protocol-relative, and non-http schemes", () => {
    expect(isValidImageUrl(null)).toBe(false);
    expect(isValidImageUrl("")).toBe(false);
    expect(isValidImageUrl("//evil.example/a.png")).toBe(false);
    expect(isValidImageUrl("javascript:alert(1)")).toBe(false);
    expect(isValidImageUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isValidImageUrl("not a url")).toBe(false);
  });
});

describe("sanitizeProfileName", () => {
  it("trims and strips control characters", () => {
    expect(sanitizeProfileName("  Bryan\u0007 ")).toBe("Bryan");
  });

  it("returns '' for non-strings", () => {
    expect(sanitizeProfileName(undefined)).toBe("");
    expect(sanitizeProfileName(42)).toBe("");
  });

  it("returns null when longer than the cap", () => {
    expect(sanitizeProfileName("a".repeat(MAX_PROFILE_NAME_LENGTH))).toBe(
      "a".repeat(MAX_PROFILE_NAME_LENGTH),
    );
    expect(
      sanitizeProfileName("a".repeat(MAX_PROFILE_NAME_LENGTH + 1)),
    ).toBeNull();
  });
});

describe("capabilitiesForRole", () => {
  it("maps known roles case-insensitively", () => {
    expect(capabilitiesForRole("Founder")).toEqual([
      "entity:read",
      "entity:manage",
      "entity:members",
    ]);
    expect(capabilitiesForRole(" manager ")).toEqual([
      "entity:read",
      "entity:manage",
    ]);
    expect(capabilitiesForRole("member")).toEqual(["entity:read"]);
  });

  it("grants nothing for unknown or missing roles", () => {
    expect(capabilitiesForRole("stranger")).toEqual([]);
    expect(capabilitiesForRole(null)).toEqual([]);
  });

  it("has a label for every capability", () => {
    for (const cap of capabilitiesForRole("admin")) {
      expect(CAPABILITY_LABELS[cap]).toBeTruthy();
    }
  });
});

describe("roleLabel", () => {
  it("prefers the free-text title verbatim", () => {
    expect(roleLabel("Head of Forecasting", "admin")).toBe(
      "Head of Forecasting",
    );
  });

  it("sentence-cases the role enum", () => {
    expect(roleLabel(null, "ADMIN")).toBe("Admin");
  });

  it("falls back to Member", () => {
    expect(roleLabel(null, null)).toBe("Member");
    expect(roleLabel("  ", "  ")).toBe("Member");
  });
});
