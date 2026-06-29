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
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder section`}
        className="absolute -left-1 top-1/2 z-10 -translate-y-1/2 cursor-grab touch-none rounded p-1 text-text-tertiary opacity-0 transition-opacity hover:text-text-secondary focus-visible:opacity-100 group-hover/draggable:opacity-100 active:cursor-grabbing"
        style={{ transform: "translateY(-50%)" }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M5 3a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zM5 7a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zM5 11a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2z" />
        </svg>
      </button>
      <div className="group/draggable rounded-[var(--radius-card)] ring-2 ring-transparent transition-all focus-within:ring-primary/30 hover:ring-primary/20">
        {children}
      </div>
    </div>
  );
}
