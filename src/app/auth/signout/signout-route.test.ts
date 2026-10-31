/**
 * /auth/signout route tests.
 *
 * GET runs the WorkOS sign-out. POST (the Mzizi account menu's sign-out form)
 * checks the Origin is this site's own and answers 303 to the GET route, with
 * a RELATIVE Location: an absolute one built from `request.url` carries
 * whatever origin the server believes it has, which behind a TLS-terminating
 * proxy can be http://localhost:PORT.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock("@workos-inc/authkit-nextjs", () => ({ signOut: signOutMock }));

import { GET, POST } from "./route";

const post = (url: string, origin?: string) =>
  new Request(url, { method: "POST", headers: origin ? { origin } : {} });

beforeEach(() => {
  signOutMock.mockReset();
});

describe("POST /auth/signout", () => {
  it("answers 303 to the GET sign-out route", async () => {
    const res = await POST(
      post(
        "https://weather.mukoko.com/auth/signout",
        "https://weather.mukoko.com",
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/signout");
  });

  it("never puts an origin in Location, even when the server sees an internal URL", async () => {
    // A TLS-terminating proxy hands the app http://localhost:3000; the Origin
    // header the browser sent has to match that Host-derived origin for the
    // same-origin check, and the redirect must still not repeat it.
    const res = await POST(
      post("http://localhost:3000/auth/signout", "http://localhost:3000"),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("/auth/signout");
    expect(location).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    expect(location).not.toContain("localhost");
    expect(location.startsWith("//")).toBe(false);
  });

  it("does not sign out by itself (the GET route it redirects to does)", async () => {
    await POST(
      post(
        "https://weather.mukoko.com/auth/signout",
        "https://weather.mukoko.com",
      ),
    );
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("refuses another site, a missing Origin and a null Origin with 403 and no Location", async () => {
    const url = "https://weather.mukoko.com/auth/signout";
    for (const origin of ["https://evil.example", undefined, "null"]) {
      const res = await POST(post(url, origin));
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
    }
  });
});

describe("GET /auth/signout", () => {
  it("runs the WorkOS sign-out and returns home", async () => {
    signOutMock.mockResolvedValue(undefined);
    const res = await GET();
    expect(signOutMock).toHaveBeenCalledWith({ returnTo: "/" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/");
  });
});
