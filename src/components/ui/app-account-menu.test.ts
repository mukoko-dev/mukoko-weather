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

describe("AccountMenu — a custom trigger class", () => {
  it("does not clip the trigger, so a .plover tap area can reach the bar's height", () => {
    const html = render({
      name: "Tendai Moyo",
      imageUrl: "/avatar.png",
      triggerClassName: "plover relative size-[var(--touch-target-min)]",
    });
    const summary = html.match(/<summary[^>]*>/)?.[0] ?? "";
    expect(summary).toContain("plover");
    expect(summary).not.toContain("overflow-hidden");
    // The photo still crops itself to the circle.
    expect(html).toMatch(/<img[^>]*rounded-full[^>]*object-cover/);
  });
});

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
  it("a trigger class replaces the avatar-row look (the bar's round control)", () => {
    const html = render({
      name: "A",
      initials: "A",
      triggerClassName: "plover",
    });
    expect(html).toMatch(/<summary[^>]*class="[^"]*plover/);
    // Not clipped: a photo crops itself, and a clip would cut a .plover tap area.
    expect(html.match(/<summary[^>]*class="([^"]*)"/)![1]).not.toContain(
      "overflow-hidden",
    );
    expect(html).not.toContain(
      "pointer-coarse:min-h-[var(--touch-target-min)]",
    );
    // The default look's own height and inset are not applied to it.
    expect(html.match(/<summary[^>]*class="([^"]*)"/)![1]).not.toContain(
      "px-[var(--inset-floor)]",
    );
  });

  it("without a trigger class it keeps the upstream avatar row, at the Bundu floor (49px tall at every pointer, 14px inline inset)", () => {
    const html = render({ name: "A", initials: "A" });
    const summary = html.match(/<summary[^>]*class="([^"]*)"/)![1];
    expect(summary).toContain("min-h-[var(--touch-target-min)]");
    expect(summary).toContain("px-[var(--inset-floor)]");
    // Upstream's 32px row (44px on touch) and its 4px inset are gone.
    expect(summary).not.toMatch(/(^|\s)h-8(\s|$)/);
    expect(summary).not.toContain("pointer-coarse:");
    // mzizi-spacing-exempt: names the class this asserts is gone
    expect(summary).not.toMatch(/(^|\s)px-1(\s|$)/);
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

describe("AccountMenu — the panel never leaves the viewport on a phone", () => {
  // The header's ⋯ is the first of three buttons in the action pill, about
  // 118px from the right edge. A panel right-aligned to it (`absolute right-0`,
  // 18rem wide) started at W - 406px: 31px off the left edge at 375px wide.
  const html = render({
    name: "A",
    initials: "A",
    triggerClassName: "bee",
    trigger: createElement("i", null, "dots"),
  });
  const panelClass = html.match(
    /<div[^>]*class="([^"]*)"[^>]*data-slot="account-menu-panel"/,
  )?.[1];
  const tokens = (panelClass ?? "").split(/\s+/).filter(Boolean);
  const phone = tokens.filter((t) => !t.includes(":"));

  it("finds the panel and its classes", () => {
    expect(panelClass).toBeDefined();
  });

  it("is pinned to the viewport's right gutter below sm (fixed, right-2), not right-aligned to its trigger", () => {
    expect(phone).toContain("fixed");
    expect(phone).toContain("right-2");
    expect(phone).not.toContain("absolute");
    expect(phone).not.toContain("right-0");
    // No `left-*`/`top-*`/`inset-*`: it keeps its static position, directly
    // under the trigger, wherever the trigger sits.
    expect(phone.some((t) => /^(left|top|bottom|inset)-/.test(t))).toBe(false);
  });

  it("is the upstream absolute, right-aligned popover from sm", () => {
    expect(tokens).toContain("sm:absolute");
    expect(tokens).toContain("sm:right-0");
  });

  it("is never wider than the viewport minus the gutter on each side, so its left edge is at or past the gutter at every phone width", () => {
    const w = panelClass!.match(
      /w-\[min\((\d+(?:\.\d+)?)rem,calc\(100vw-(\d+(?:\.\d+)?)rem\)\)\]/,
    );
    expect(w, "panel width must be min(Nrem, 100vw - Mrem)").not.toBeNull();
    const maxPx = Number(w![1]) * 16;
    const shrinkPx = Number(w![2]) * 16;
    const rightPx =
      Number(phone.find((t) => /^right-\d+$/.test(t))!.slice(6)) * 4;
    for (let viewport = 280; viewport < 640; viewport++) {
      const width = Math.min(maxPx, viewport - shrinkPx);
      const left = viewport - rightPx - width;
      expect(left, `left edge at ${viewport}px wide`).toBeGreaterThanOrEqual(
        rightPx,
      );
    }
  });

  it("still scrolls inside the viewport height", () => {
    expect(tokens).toContain("max-h-[calc(100dvh-7rem)]");
    expect(tokens).toContain("overflow-y-auto");
  });
});

describe("AccountMenu — panelPlacement", () => {
  const panelOf = (props: Record<string, unknown>) =>
    render({ name: "A", initials: "A", ...props }).match(
      /<div[^>]*class="([^"]*)"[^>]*data-slot="account-menu-panel"/,
    )![1];
  const detailsOf = (props: Record<string, unknown>) =>
    render({ name: "A", initials: "A", ...props }).match(/^<details[^>]*>/)![0];

  it("defaults to below the trigger: the details is the panel's positioned anchor", () => {
    expect(detailsOf({})).toContain("relative");
    expect(panelOf({}).split(/\s+/)).toContain("fixed");
    expect(panelOf({ panelPlacement: "below" })).toBe(panelOf({}));
  });

  describe("above (the phone bottom bar's account control)", () => {
    const panel = panelOf({ panelPlacement: "above" });
    const tokens = panel.split(/\s+/).filter(Boolean);

    it("opens upward from the nearest positioned ancestor, not the trigger: static details, absolute bottom-full panel", () => {
      expect(detailsOf({ panelPlacement: "above" })).not.toContain("relative");
      expect(tokens).toContain("absolute");
      expect(tokens).toContain("bottom-full");
      // The bar's last slot is the far right, so the panel hangs from the
      // bar's right edge (2026-11-11), not its left.
      expect(tokens).toContain("right-0");
      expect(tokens).not.toContain("left-0");
      // A gap from the float grid between the panel and the bar.
      expect(tokens).toContain("mb-[var(--float-gap)]");
    });

    it("is not fixed: a backdrop-filter bar would make it the containing block", () => {
      expect(tokens).not.toContain("fixed");
      expect(tokens).not.toContain("right-2");
      expect(tokens).not.toContain("mt-1");
    });

    it("keeps the card surface, the scroll and the stacking of the other placement", () => {
      for (const token of [
        "z-40",
        "overflow-y-auto",
        "rounded-[var(--radius-card)]",
        "border",
        "bg-popover",
      ]) {
        expect(tokens, token).toContain(token);
      }
    });

    it("never leaves the bar's span sideways: the width is capped by the float insets at every phone width and inset", () => {
      const w = panel.match(
        /w-\[min\((\d+(?:\.\d+)?)rem,calc\(100vw-var\(--float-left\)-var\(--float-right\)\)\)\]/,
      );
      expect(
        w,
        "width must be min(Nrem, 100vw - float-left - float-right)",
      ).not.toBeNull();
      const maxPx = Number(w![1]) * 16;
      // --float-left / --float-right = max(1rem, safe-area inset).
      for (const inset of [0, 20, 47]) {
        const edge = Math.max(16, inset);
        for (let viewport = 280; viewport < 640; viewport++) {
          const width = Math.min(maxPx, viewport - edge - edge);
          // The panel's right edge is the bar's (right-0 of the fixed bar).
          const right = viewport - edge;
          const left = right - width;
          expect(
            left,
            `left edge at ${viewport}px, inset ${inset}`,
          ).toBeGreaterThanOrEqual(edge);
          expect(
            right,
            `right edge at ${viewport}px, inset ${inset}`,
          ).toBeLessThanOrEqual(viewport - edge);
        }
      }
    });

    it("never leaves the screen upward: its height is the room above the bar", () => {
      const h = panel.match(/max-h-\[calc\(([^\]]+)\)\]/);
      expect(h).not.toBeNull();
      expect(h![1]).toBe(
        "100dvh-var(--float-top)-var(--float-bottom)-var(--mobile-nav-bar-height)-var(--float-gap)",
      );
      // 16px top, 20px lift, 72px bar, 8px gap: room even on a 568px screen.
      const room = (height: number) => height - 16 - 20 - 72 - 8;
      for (const height of [480, 568, 640, 740, 852, 932]) {
        expect(room(height), `${height}px`).toBeGreaterThan(300);
      }
    });
  });
});
