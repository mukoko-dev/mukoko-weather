import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "PWAInstallPrompt.tsx"), "utf-8");

describe("PWAInstallPrompt — component structure", () => {
  it("is a client component", () => {
    expect(src).toMatch(/^"use client"/);
  });

  it("installs through the shared install module, not its own event listener", () => {
    expect(src).toContain('from "@/lib/install-app"');
    expect(src).toContain("requestInstall()");
    expect(src).not.toContain("addEventListener");
  });

  it("only offers the dialog when an install can start (not installed, supported)", () => {
    expect(src).toContain("useCanInstall()");
  });

  it("respects dismissal cooldown via localStorage", () => {
    expect(src).toContain("mukoko-pwa-install-dismissed");
  });

  it("uses safe-storage and never touches raw localStorage/sessionStorage", () => {
    expect(src).toContain('from "@/lib/safe-storage"');
    expect(src).not.toMatch(/\b(local|session)Storage\b/);
  });

  it("delays showing the prompt to let user experience the app", () => {
    expect(src).toContain("SHOW_DELAY_MS");
  });

  it("tracks install events via analytics", () => {
    expect(src).toContain("trackEvent");
    expect(src).toContain("pwa_install");
  });

  it("calls requestInstall first in the tap handler, before any await", () => {
    const fn = src.slice(
      src.indexOf("const handleInstall"),
      src.indexOf("const handleDismiss"),
    );
    expect(fn.indexOf("requestInstall()")).toBeGreaterThan(-1);
    expect(fn.indexOf("requestInstall()")).toBeLessThan(fn.indexOf("await pending"));
  });

  it("handleDismiss does not record a dismissal once Install was pressed", () => {
    expect(src).toMatch(
      /const handleDismiss[\s\S]*?if\s*\(\s*acted\.current\s*\)\s*return/,
    );
  });
});

describe("PWAInstallPrompt — accessibility", () => {
  it("uses Dialog component from shadcn/ui", () => {
    expect(src).toContain("@/components/ui/dialog");
    expect(src).toContain("<Dialog");
  });

  it("names the dialog for screen readers (the shared bar's title)", () => {
    // The title is the bar's (`heading`), which is a DialogTitle: Radix
    // labels the dialog by it.
    expect(src).toContain('heading="Install mukoko weather"');
  });

  it("has DialogDescription for screen readers", () => {
    expect(src).toContain("<DialogDescription");
  });

  it("uses Button primitive from ui library", () => {
    expect(src).toContain("@/components/ui/button");
    expect(src).toContain("<Button");
  });

  it("install button has 56px height touch target", () => {
    expect(src).toContain("min-h-[var(--touch-target-min)]");
  });
});

describe("PWAInstallPrompt — styling", () => {
  it("uses no hardcoded colors", () => {
    expect(src).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    expect(src).not.toMatch(/rgb\(/);
    expect(src).not.toMatch(/rgba\(/);
  });

  it("uses CSS custom property classes", () => {
    expect(src).toContain("bg-primary");
    expect(src).toContain("text-primary");
  });
});
