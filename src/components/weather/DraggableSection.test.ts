/**
 * Tests for DraggableSection — validates the dnd-kit sortable wiring and, in
 * particular, that the drag handle is actually visible/usable in reorder mode.
 * Vitest runs in Node without a DOM, so we assert against the source text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "DraggableSection.tsx"), "utf-8");

describe("DraggableSection — client component", () => {
  it("is a client component with 'use client' directive", () => {
    expect(source).toContain('"use client"');
  });

  it("exports DraggableSection as a named function", () => {
    expect(source).toContain("export function DraggableSection");
  });

  it("uses dnd-kit useSortable for drag-and-drop", () => {
    expect(source).toContain("useSortable");
    expect(source).toContain("@dnd-kit/sortable");
  });

  it("renders a STABLE wrapper element in both modes (no unmount/remount)", () => {
    // The wrapper must not swap element type between modes — that would force
    // React to unmount/remount every section (refetch AI summary, drop chat,
    // rebuild charts, recreate the Three.js hero) when toggling reorder mode.
    // The old early-return fragment is gone; a single ref'd <div> always renders.
    expect(source).not.toContain("if (!reordering) return <>{children}</>");
    expect(source).toContain("<div ref={setNodeRef}");
  });

  it("toggles only drag props/handle/styling on the reordering flag, never the element type", () => {
    // The handle button is conditionally mounted, and styling is gated on the
    // flag, but the wrapper <div> and inner children wrapper are unconditional.
    expect(source).toContain("{reordering && (");
    expect(source).toContain("className={reordering ? \"relative\" : undefined}");
  });
});

describe("DraggableSection — drag handle usability (regression)", () => {
  it("wires dnd-kit attributes and listeners onto the handle button", () => {
    expect(source).toContain("{...attributes}");
    expect(source).toContain("{...listeners}");
  });

  it("does not hide the handle with opacity-0 (mouse/touch users could never grab it)", () => {
    expect(source).not.toContain("opacity-0");
  });

  it("does not rely on the broken group-hover selector to reveal the handle", () => {
    // The `.group/draggable` element was a sibling of the handle, so
    // `group-hover/draggable:opacity-100` never matched — the handle stayed hidden.
    expect(source).not.toContain("group-hover/draggable");
    expect(source).not.toContain("group/draggable");
  });

  it("marks the handle with an accessible label and touch-none for dragging", () => {
    expect(source).toContain('aria-label="Drag to reorder section"');
    expect(source).toContain("touch-none");
    expect(source).toContain("cursor-grab");
  });

  it("styles the handle via CSS custom properties, not hardcoded colors", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(source).toContain("bg-surface-card");
  });
});
