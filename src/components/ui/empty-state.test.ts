import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "empty-state.tsx"), "utf-8");

describe("EmptyState", () => {
  it("exports EmptyState", () => {
    expect(source).toContain("export function EmptyState");
  });

  it("wraps children in a paragraph so screen readers announce the text", () => {
    expect(source).toContain("<p>{children}</p>");
  });

  it("uses card and text tokens, no hardcoded colors or inline styles", () => {
    expect(source).toContain("bg-surface-card");
    expect(source).toContain("text-text-tertiary");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });

  it("lets callers control spacing via className", () => {
    expect(source).toContain("className");
    expect(source).toContain("cn(");
  });
});

describe("EmptyState usage sites", () => {
  const files = [
    "../../app/explore/page.tsx",
    "../../app/explore/[tag]/page.tsx",
    "../../app/explore/country/[code]/page.tsx",
  ];

  it("explore empty-list states use the shared EmptyState", () => {
    for (const file of files) {
      const s = readFileSync(resolve(__dirname, file), "utf-8");
      expect(s).toContain(
        'import { EmptyState } from "@/components/ui/empty-state"',
      );
      expect(s).toContain("<EmptyState");
      expect(s).not.toContain(
        "rounded-[var(--radius-card)] bg-surface-card p-6 text-center",
      );
    }
  });
});
