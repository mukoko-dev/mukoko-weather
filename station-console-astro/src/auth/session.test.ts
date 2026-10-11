import { describe, expect, it } from "vitest";
import { callerFrom, mockUser, parseMockCookie } from "./session";

describe("callerFrom", () => {
  it("is null for anonymous or missing auth", () => {
    expect(callerFrom(undefined)).toBeNull();
    expect(callerFrom({ user: null })).toBeNull();
  });
  it("maps the session user and keeps the token server-side", () => {
    expect(
      callerFrom({ user: { id: "u1", email: "a@b.test" }, accessToken: "t" }),
    ).toEqual({ personId: "u1", email: "a@b.test", accessToken: "t" });
    expect(callerFrom({ user: { id: "u1" } })?.email).toBe("");
  });
});

describe("mock session", () => {
  it("derives stable identities and rejects odd slugs", () => {
    expect(mockUser("alice")).toEqual({
      id: "mock-alice",
      email: "alice@example.test",
    });
    expect(mockUser("../x").id).toBe("mock-owner");
    expect(mockUser(null).id).toBe("mock-owner");
  });
  it("parses only well-formed cookies", () => {
    expect(parseMockCookie("a=1; mock_session=bob; b=2")).toBe("bob");
    expect(parseMockCookie("mock_session=<script>")).toBeNull();
    expect(parseMockCookie(null)).toBeNull();
  });
});
