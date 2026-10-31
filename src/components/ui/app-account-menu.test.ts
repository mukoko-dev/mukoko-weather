/**
 * The vendored Mzizi app-account-menu, rendered for real (react-dom/server):
 * what a signed-in and a signed-out visitor get, the trigger variants, the
 * POST sign-out form and per-instance ids.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { AccountMenu } from "./app-account-menu";

const row = createElement("a", { href: "/history" }, "History");

function render(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(AccountMenu, props as never, row));
}

describe("AccountMenu — signed in", () => {
  const html = render({
    name: "Tendai Moyo",
    email: "tendai@example.com",
    initials: "TM",
    signOutAction: "/auth/signout",
  });

  it("is a <details> disclosure whose summary names the account", () => {
    expect(html).toMatch(/^<details/);
    expect(html).toContain('data-slot="account-menu"');
    expect(html).toContain("<summary");
    expect(html).toContain("Account menu for Tendai Moyo");
  });

  it("draws initials in the avatar (aria-hidden) and the identity in the panel", () => {
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>TM<\/span>/);
    expect(html).toContain("Tendai Moyo");
    expect(html).toContain("tendai@example.com");
  });

  it("holds the app's rows in the slot", () => {
    expect(html).toContain('<a href="/history">History</a>');
  });

  it("signs out with a POST form, not a link", () => {
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html).toMatch(/<form[^>]*action="\/auth\/signout"/);
    expect(html).toContain('type="submit"');
    expect(html).toContain("Sign out");
    expect(html).not.toMatch(/<a[^>]*href="\/auth\/signout"/);
  });

  it("points the trigger at the panel with one id", () => {
    const controls = html.match(/aria-controls="([^"]+)"/)![1];
    expect(html).toContain(`id="${controls}"`);
  });
});

describe("AccountMenu — photo", () => {
  it("draws a valid profile picture and refuses a script URL", () => {
    const ok = render({
      name: "A",
      initials: "A",
      imageUrl: "https://example.com/a.png",
    });
    expect(ok).toContain('src="https://example.com/a.png"');
    const bad = render({
      name: "A",
      initials: "A",
      imageUrl: "javascript:alert(1)",
    });
    expect(bad).not.toContain("javascript:");
    expect(bad).toMatch(/>A<\/span>/);
  });
});

describe("AccountMenu — signed out", () => {
  const html = render({
    signInHref: "/auth/signin",
    signOutAction: "/auth/signout",
  });

  it("shows the user icon, no identity and no sign-out form", () => {
    expect(html).toContain("Account menu");
    expect(html).not.toContain("Account menu for");
    expect(html).not.toContain("Signed in");
    expect(html).not.toContain("<form");
    expect(html).toContain("lucide-user");
  });

  it("offers a Sign in row", () => {
    expect(html).toContain('href="/auth/signin"');
    expect(html).toContain("Sign in");
  });
});

describe("AccountMenu — trigger variants", () => {
  it("a trigger class replaces the avatar-row look and crops to a circle (the hero's round control)", () => {
    const html = render({
      name: "A",
      initials: "A",
      triggerClassName: "kestrel-round",
    });
    expect(html).toMatch(/<summary[^>]*class="[^"]*kestrel-round/);
    expect(html).toContain("overflow-hidden");
    expect(html).not.toContain(
      "pointer-coarse:min-h-[var(--touch-target-min)]",
    );
  });

  it("without a trigger class it keeps the upstream avatar row, 48px on touch", () => {
    const html = render({ name: "A", initials: "A" });
    expect(html).toContain("pointer-coarse:min-h-[var(--touch-target-min)]");
  });

  it("a trigger node and label replace the avatar and the name (the header's ⋯)", () => {
    const html = render({
      name: "A",
      initials: "A",
      trigger: createElement("i", null, "dots"),
      triggerLabel: "More options",
    });
    expect(html).toContain("<i>dots</i>");
    expect(html).toContain("More options");
    expect(html).not.toContain("Account menu for");
  });

  it("two instances never share an id", () => {
    const a = render({ name: "A" }).match(/id="([^"]+)"/)![1];
    const b = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(AccountMenu, { name: "A" } as never),
        createElement(AccountMenu, { name: "B" } as never),
      ),
    ).match(/id="([^"]+)"/g)!;
    expect(new Set(b).size).toBe(2);
    expect(a).toBeTruthy();
  });
});
