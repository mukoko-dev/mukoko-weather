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
 * In normal mode, renders children with zero overhead (no extra DOM nodes).
 */
export function DraggableSection({ id, reordering, children }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  if (!reordering) return <>{children}</>;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  } as React.CSSProperties;

  return (
    <div ref={setNodeRef} style={style} className="relative">
      {/* Drag handle — always visible while in reorder mode. It previously tried to
          reveal itself on hover of the card, but the hovered element was a SIBLING of
          this button (not an ancestor), so the hover selector never matched and the
          handle stayed hidden for mouse/touch users — making reordering impossible.
          Since DraggableSection only mounts this button when `reordering` is true, we
          show it outright. */}
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
      {/* Left padding reserves room for the always-on handle so it doesn't overlap content. */}
      <div className="rounded-[var(--radius-card)] pl-10 ring-2 ring-primary/20 transition-all focus-within:ring-primary/40">
        {children}
      </div>
    </div>
  );
}
