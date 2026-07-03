"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";

interface Props {
  id: string;
  reordering: boolean;
  children: ReactNode;
}

/**
 * Wraps a weather section with dnd-kit drag-and-drop when reorder mode is active.
 *
 * The wrapper element type is STABLE across modes — a single `<div ref={setNodeRef}>`
 * is rendered whether or not `reordering` is on. Toggling only the drag handle,
 * listeners, and styling (never the element type) means React reconciles instead
 * of unmounting: `children` keep their component instances, so entering/leaving
 * "Customise layout" no longer refetches the AI summary, drops the chat, rebuilds
 * charts, or recreates the Three.js hero.
 */
export function DraggableSection({ id, reordering, children }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = reordering
    ? ({
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
      } as React.CSSProperties)
    : undefined;

  return (
    <div ref={setNodeRef} style={style} className={reordering ? "relative" : undefined}>
      {/* Drag handle — only mounted in reorder mode. It previously tried to reveal
          itself on hover of the card, but the hovered element was a SIBLING of this
          button (not an ancestor), so the hover selector never matched and the handle
          stayed hidden for mouse/touch users. It is now shown outright while reordering. */}
      {reordering && (
        <button
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder section"
          className="absolute left-1 top-2 z-10 flex h-8 min-h-0 w-8 cursor-grab touch-none items-center justify-center rounded-full border border-primary/25 bg-surface-card text-text-secondary shadow-sm transition-colors hover:border-primary/40 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M5 3a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zM5 7a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zM5 11a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2z" />
          </svg>
        </button>
      )}
      {/* Inner wrapper is always present so children never remount. In reorder mode
          the left padding reserves room for the always-on handle and a ring frames
          the draggable card. */}
      <div
        className={
          reordering
            ? "rounded-[var(--radius-card)] pl-10 ring-2 ring-primary/20 transition-all focus-within:ring-primary/40"
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
