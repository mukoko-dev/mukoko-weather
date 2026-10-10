/**
 * Tests for /profile — the Mukoko ecosystem profile standard (mukoko-news
 * /profile, mukoko-events /profile). Structural checks read the source files
 * directly (no DOM renderer), matching this repo's component-test convention.
 */
import { describe, it, expect, vi } from "vitest";

// The server action pulls in AuthKit (Next server internals); the structural
// tests only need the exported constants, so stub it.
vi.mock("@/app/profile/actions", () => ({ updateProfileAction: vi.fn() }));
import { readFileSync } from "fs";
import { resolve } from "path";
import { APP_VERSION_LABEL } from "./ProfileClient";
import {
  PROFILE_DESTINATIONS,
  PROFILE_NAV_GROUPS,
} from "@/components/profile/ProfileNavigation";
import { THEME_OPTIONS } from "@/components/profile/ProfileAppearance";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");
const client = read("ProfileClient.tsx");
const page = read("page.tsx");
const actions = read("actions.ts");
const identity = read("../../components/profile/ProfileIdentity.tsx");
const orgs = read("../../components/profile/ProfileOrganizations.tsx");
const appearance = read("../../components/profile/ProfileAppearance.tsx");
const nav = read("../../components/profile/ProfileNavigation.tsx");
const pkg = JSON.parse(read("../../../package.json")) as { version: string };
const css = read("../globals.css");
const all = [client, identity, orgs, appearance, nav];

describe("/profile page — server wrapper", () => {
  it("is gated by requireUser and returns to /profile", () => {
    expect(page).toContain('requireUser("/profile")');
  });

  it("reads identity.persons + memberships server-side (source of truth)", () => {
    expect(page).toContain("getMyProfile(user)");
    expect(page).toContain("getMyOrganizations(profile.personId)");
    expect(page).toContain("firstName: profile.givenName");
    expect(page).toContain("pictureUrl: profile.picture");
  });

  it("keeps the noindex robots + canonical metadata", () => {
    expect(page).toContain("index: false");
    expect(page).toContain("/profile`");
  });
});

describe("ProfileClient — section order mirrors the ecosystem standard", () => {
  it("composes identity → preferences → organizations → appearance → navigation → sign out", () => {
    const order = [
      "<ProfileIdentity",
      'id="preferences-heading"',
      "<ProfileOrganizations",
      "<ProfileAppearance",
      "<ProfileNavigation",
      'href="/auth/signout"',
      "A Mukoko Product by Nyuchi Africa",
    ].map((needle) => client.indexOf(needle));
    for (const pos of order) expect(pos).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps the My Weather modal as the preferences entry point", () => {
    expect(client).toContain("useAppStore");
    expect(client).toContain("onClick={() => openMyWeather()}");
    expect(client).toContain("My Weather");
  });

  it("the version line matches package.json", () => {
    expect(APP_VERSION_LABEL).toBe(`mukoko weather v${pkg.version}`);
  });
});

describe("ProfileIdentity", () => {
  it("is a client component that edits the name through the server action", () => {
    expect(identity).toContain('"use client"');
    expect(identity).toContain("updateProfileAction");
    expect(identity).toContain('autoComplete="given-name"');
    expect(identity).toContain('autoComplete="family-name"');
  });

  it("renders the picture only when it is a valid URL, else initials", () => {
    expect(identity).toContain("isValidImageUrl(pictureUrl)");
    expect(identity).toContain("initialsFor(");
    expect(identity).toContain("onError={() => setImageFailed(true)}");
  });

  it("is accessible: labelled edit button, alert + status messages, h1", () => {
    expect(identity).toContain('aria-label="Edit your profile"');
    expect(identity).toContain('role="alert"');
    expect(identity).toContain('role="status"');
    expect(identity).toContain("<h1");
  });
});

describe("profile server action", () => {
  it("is a server action that takes no user id (session-derived)", () => {
    expect(actions).toContain('"use server"');
    expect(actions).toContain("getCurrentUser()");
    expect(actions).not.toMatch(/userId:\s*string;\s*firstName/);
  });

  it("writes identity.persons first, then mirrors to WorkOS best-effort", () => {
    const write = actions.indexOf("await updateMyName(");
    const mirror = actions.indexOf("await mirrorNameToWorkOS(");
    expect(write).toBeGreaterThan(-1);
    expect(mirror).toBeGreaterThan(write);
    expect(actions).toContain("userManagement.updateUser");
  });
});

describe("ProfileOrganizations", () => {
  it("renders nothing when there are no memberships", () => {
    expect(orgs).toContain("if (organizations.length === 0) return null;");
  });

  it("states the per-organization scope", () => {
    expect(orgs).toContain(
      "These permissions apply to each organization on its own.",
    );
  });
});

describe("ProfileAppearance", () => {
  it("offers light, dark and system as radios", () => {
    expect(THEME_OPTIONS.map((t) => t.value)).toEqual([
      "light",
      "dark",
      "system",
    ]);
    expect(appearance).toContain('role="radio"');
    expect(appearance).toContain("aria-checked={selected}");
    expect(appearance).toContain("setTheme(t.value)");
  });
});

describe("ProfileNavigation", () => {
  it("every destination belongs to a declared group", () => {
    const ids = new Set(PROFILE_NAV_GROUPS.map((g) => g.id));
    for (const d of PROFILE_DESTINATIONS) expect(ids.has(d.group)).toBe(true);
  });

  it("has unique in-app hrefs", () => {
    const hrefs = PROFILE_DESTINATIONS.map((d) => d.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const h of hrefs) expect(h.startsWith("/")).toBe(true);
  });

  it("does not link to the paused Shamwari chat", () => {
    expect(PROFILE_DESTINATIONS.some((d) => d.href === "/shamwari")).toBe(
      false,
    );
  });

  it("is a labelled nav landmark", () => {
    expect(nav).toContain('aria-label="All pages"');
  });
});

describe("profile — styling + accessibility", () => {
  it("uses the .guineafowl list-card fauna, defined in globals.css", () => {
    for (const cls of ["guineafowl", "guineafowl-heading", "guineafowl-row"]) {
      expect(css).toContain(`.${cls} {`);
    }
    expect(client).toContain("guineafowl");
  });

  it("never hardcodes colours or inline styles", () => {
    for (const src of all) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/rgba?\(/);
      expect(src).not.toContain("style={{");
    }
  });

  it("every section is labelled by its heading id", () => {
    for (const src of [client, orgs, appearance, nav]) {
      const labelled = [...src.matchAll(/aria-labelledby=\{?"?([\w-]+)/g)];
      expect(labelled.length).toBeGreaterThan(0);
    }
  });

  it("marks decorative icons aria-hidden", () => {
    expect(nav).toContain('aria-hidden="true"');
    expect(client).toContain('aria-hidden="true"');
  });
});
