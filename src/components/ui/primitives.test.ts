import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Alert — variant and export tests
// ---------------------------------------------------------------------------

describe("Alert", () => {
  it("exports Alert, AlertTitle, AlertDescription, alertVariants", async () => {
    const mod = await import("./alert");
    expect(mod.Alert).toBeDefined();
    expect(mod.AlertTitle).toBeDefined();
    expect(mod.AlertDescription).toBeDefined();
    expect(mod.alertVariants).toBeDefined();
  });

  it("alertVariants has 6 severity variants", async () => {
    const { alertVariants } = await import("./alert");
    const variants = ["default", "info", "warning", "severe", "frost", "success"] as const;
    for (const v of variants) {
      const classes = alertVariants({ variant: v });
      expect(classes).toBeTruthy();
    }
  });

  it("default/info variants use brand primary", async () => {
    const { alertVariants } = await import("./alert");
    expect(alertVariants({ variant: "default" })).toContain("border-primary/50");
    expect(alertVariants({ variant: "info" })).toContain("bg-primary/5");
  });

  it("warning variant uses severity-moderate tokens", async () => {
    const { alertVariants } = await import("./alert");
    expect(alertVariants({ variant: "warning" })).toContain("border-severity-moderate");
    expect(alertVariants({ variant: "warning" })).toContain("bg-severity-moderate/10");
  });

  it("severe variant uses severity-severe tokens", async () => {
    const { alertVariants } = await import("./alert");
    expect(alertVariants({ variant: "severe" })).toContain("border-severity-severe");
  });

  it("frost variant uses severity-cold tokens", async () => {
    const { alertVariants } = await import("./alert");
    expect(alertVariants({ variant: "frost" })).toContain("border-severity-cold");
    expect(alertVariants({ variant: "frost" })).toContain("bg-severity-cold/10");
  });

  it("success variant uses severity-low tokens", async () => {
    const { alertVariants } = await import("./alert");
    expect(alertVariants({ variant: "success" })).toContain("border-severity-low");
  });

  it("no variant uses hardcoded hex colors or rgba", async () => {
    const { alertVariants } = await import("./alert");
    for (const v of ["default", "info", "warning", "severe", "frost", "success"] as const) {
      const classes = alertVariants({ variant: v });
      expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(classes).not.toMatch(/rgba?\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// Tabs — focus-visible validation
// ---------------------------------------------------------------------------

describe("Tabs", () => {
  it("exports Tabs, TabsList, TabsTrigger, TabsContent", async () => {
    const mod = await import("./tabs");
    expect(mod.Tabs).toBeDefined();
    expect(mod.TabsList).toBeDefined();
    expect(mod.TabsTrigger).toBeDefined();
    expect(mod.TabsContent).toBeDefined();
  });

  it("TabsTrigger has focus-visible styles for keyboard accessibility", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(resolve(__dirname, "tabs.tsx"), "utf-8");
    expect(src).toContain("focus-visible:outline");
    expect(src).toContain("focus-visible:outline-primary");
  });
});

// ---------------------------------------------------------------------------
// Accordion — export validation
// ---------------------------------------------------------------------------

describe("Accordion", () => {
  it("exports Accordion, AccordionItem, AccordionTrigger, AccordionContent", async () => {
    const mod = await import("./accordion");
    expect(mod.Accordion).toBeDefined();
    expect(mod.AccordionItem).toBeDefined();
    expect(mod.AccordionTrigger).toBeDefined();
    expect(mod.AccordionContent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// StatusIndicator — style mapping tests
// ---------------------------------------------------------------------------

describe("StatusIndicator styles", () => {
  it("exports StatusDot, StatusBadge, statusDotVariants, ServiceStatus type", async () => {
    const mod = await import("./status-indicator");
    expect(mod.StatusDot).toBeDefined();
    expect(mod.StatusBadge).toBeDefined();
    expect(mod.statusDotVariants).toBeDefined();
  });

  it("statusDotVariants covers all three statuses with severity tokens", async () => {
    const { statusDotVariants } = await import("./status-indicator");
    const operational = statusDotVariants({ status: "operational" });
    const degraded = statusDotVariants({ status: "degraded" });
    const down = statusDotVariants({ status: "down" });

    expect(operational).toContain("bg-severity-low");
    expect(degraded).toContain("bg-severity-moderate");
    expect(down).toContain("bg-severity-severe");
  });

  it("statusDotVariants supports 3 size options", async () => {
    const { statusDotVariants } = await import("./status-indicator");
    const sm = statusDotVariants({ status: "operational", size: "sm" });
    const def = statusDotVariants({ status: "operational", size: "default" });
    const lg = statusDotVariants({ status: "operational", size: "lg" });

    expect(sm).toContain("h-2");
    expect(sm).toContain("w-2");
    expect(def).toContain("h-3");
    expect(def).toContain("w-3");
    expect(lg).toContain("h-4");
    expect(lg).toContain("w-4");
  });

  it("default size is h-3 w-3", async () => {
    const { statusDotVariants } = await import("./status-indicator");
    const classes = statusDotVariants({ status: "operational" });
    expect(classes).toContain("h-3");
    expect(classes).toContain("w-3");
  });

  it("all dots render as rounded-full circles", async () => {
    const { statusDotVariants } = await import("./status-indicator");
    for (const status of ["operational", "degraded", "down"] as const) {
      expect(statusDotVariants({ status })).toContain("rounded-full");
    }
  });
});

// ---------------------------------------------------------------------------
// CTACard — variant tests
// ---------------------------------------------------------------------------

describe("CTACard variants", () => {
  it("exports CTACard and ctaCardVariants", async () => {
    const mod = await import("./cta-card");
    expect(mod.CTACard).toBeDefined();
    expect(mod.ctaCardVariants).toBeDefined();
  });

  it("default variant uses surface-card background", async () => {
    const { ctaCardVariants } = await import("./cta-card");
    const defaultCard = ctaCardVariants({ variant: "default" });
    expect(defaultCard).toContain("bg-surface-card");
    expect(defaultCard).not.toContain("border-primary");
  });

  it("accent variant uses primary border and background", async () => {
    const { ctaCardVariants } = await import("./cta-card");
    const accentCard = ctaCardVariants({ variant: "accent" });
    expect(accentCard).toContain("border-primary/20");
    expect(accentCard).toContain("bg-primary/5");
  });

  it("all variants use brand radius token", async () => {
    const { ctaCardVariants } = await import("./cta-card");
    for (const v of ["default", "accent"] as const) {
      expect(ctaCardVariants({ variant: v })).toContain("rounded-[var(--radius-card)]");
    }
  });
});

// ---------------------------------------------------------------------------
// ToggleGroup — variant tests
// ---------------------------------------------------------------------------

describe("ToggleGroup variants", () => {
  it("exports ToggleGroup, ToggleGroupItem, toggleGroupItemVariants", async () => {
    const mod = await import("./toggle-group");
    expect(mod.ToggleGroup).toBeDefined();
    expect(mod.ToggleGroupItem).toBeDefined();
    expect(mod.toggleGroupItemVariants).toBeDefined();
  });

  it("default variant uses data-state selectors for active/inactive", async () => {
    const { toggleGroupItemVariants } = await import("./toggle-group");
    const classes = toggleGroupItemVariants({ variant: "default" });

    expect(classes).toContain("data-[state=on]:bg-primary");
    expect(classes).toContain("data-[state=on]:text-primary-foreground");
    expect(classes).toContain("data-[state=off]:bg-surface-base");
    expect(classes).toContain("data-[state=off]:text-text-secondary");
  });

  it("outline variant uses border-based active state", async () => {
    const { toggleGroupItemVariants } = await import("./toggle-group");
    const classes = toggleGroupItemVariants({ variant: "outline" });

    expect(classes).toContain("data-[state=on]:border-primary");
    expect(classes).toContain("data-[state=on]:bg-primary/5");
    expect(classes).toContain("border-2");
  });

  it("unstyled variant has no data-state selectors", async () => {
    const { toggleGroupItemVariants } = await import("./toggle-group");
    const classes = toggleGroupItemVariants({ variant: "unstyled" });

    expect(classes).toContain("shrink-0");
    expect(classes).not.toContain("data-[state=on]");
    expect(classes).not.toContain("data-[state=off]");
  });

  it("all variants include focus-visible and disabled styles", async () => {
    const { toggleGroupItemVariants } = await import("./toggle-group");
    for (const variant of ["default", "outline", "unstyled"] as const) {
      const classes = toggleGroupItemVariants({ variant });
      expect(classes).toContain("focus-visible:outline");
      expect(classes).toContain("disabled:pointer-events-none");
      expect(classes).toContain("disabled:opacity-50");
    }
  });

  it("default and outline variants enforce 44px min touch target", async () => {
    const { toggleGroupItemVariants } = await import("./toggle-group");
    for (const variant of ["default", "outline"] as const) {
      expect(toggleGroupItemVariants({ variant })).toContain("min-h-[44px]");
    }
  });
});

// ---------------------------------------------------------------------------
// ScrollArea — export validation
// ---------------------------------------------------------------------------

describe("ScrollArea", () => {
  it("exports ScrollArea and ScrollBar components", async () => {
    const mod = await import("./scroll-area");
    expect(mod.ScrollArea).toBeDefined();
    expect(mod.ScrollBar).toBeDefined();
  });

  it("supports fixRadixTableLayout prop to scope display:block override", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(resolve(__dirname, "scroll-area.tsx"), "utf-8");
    expect(src).toContain("fixRadixTableLayout");
    // Override should only apply when fixRadixTableLayout is true, not globally
    expect(src).toContain('fixRadixTableLayout && "[&>div]:!block"');
  });

  it("supports viewportRef prop for direct viewport access", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(resolve(__dirname, "scroll-area.tsx"), "utf-8");
    expect(src).toContain("viewportRef");
    // Ref is forwarded to the Radix Viewport element
    expect(src).toContain("ref={viewportRef}");
  });
});

// ---------------------------------------------------------------------------
// InfoRow — export validation
// ---------------------------------------------------------------------------

describe("InfoRow", () => {
  it("exports InfoRow component", async () => {
    const mod = await import("./info-row");
    expect(mod.InfoRow).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SectionHeader — export validation
// ---------------------------------------------------------------------------

describe("SectionHeader", () => {
  it("exports SectionHeader component", async () => {
    const mod = await import("./section-header");
    expect(mod.SectionHeader).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MetricCard — export and gauge constant tests
// ---------------------------------------------------------------------------

describe("MetricCard", () => {
  it("exports MetricCard and ArcGauge components", async () => {
    const mod = await import("@/components/weather/MetricCard");
    expect(mod.MetricCard).toBeDefined();
    expect(mod.ArcGauge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ActivityCard — export validation
// ---------------------------------------------------------------------------

describe("ActivityCard", () => {
  it("exports ActivityCard component", async () => {
    const mod = await import("@/components/weather/ActivityCard");
    expect(mod.ActivityCard).toBeDefined();
  });
});
