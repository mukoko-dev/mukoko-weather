"use client";

import {
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SURFACE = {
  base: "bg-surface-base",
  card: "bg-surface-card",
} as const;

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called on form submit and on Enter (Shift+Enter inserts a newline). */
  onSend: () => void;
  disabled?: boolean;
  /** Auto-grow ceiling in px; the textarea scrolls beyond it. */
  maxHeight?: number;
  placeholder?: string;
  /** Accessible name for the textarea. */
  ariaLabel: string;
  /** Accessible name for the send button. */
  sendLabel?: string;
  surface?: keyof typeof SURFACE;
  /** Optional ref so the parent can refocus the textarea. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

/**
 * Claude-style chat composer: auto-growing textarea, Enter-to-send, and a
 * round send button. Fully controlled by the parent.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled = false,
  maxHeight = 96,
  placeholder,
  ariaLabel,
  sendLabel = "Send message",
  surface = "base",
  textareaRef,
  className,
}: ChatComposerProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? localRef;

  // Re-measure whenever the value changes — including the reset to "" after
  // a send, so the textarea collapses back to one row.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight, ref]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSend();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <form onSubmit={handleSubmit} className={className}>
      <div
        data-slot="chat-composer"
        className={cn(
          "rounded-[var(--radius-card)] border border-border shadow-sm",
          SURFACE[surface],
        )}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="block w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 pb-1 text-base text-text-primary placeholder:text-text-tertiary outline-none disabled:cursor-not-allowed disabled:opacity-50"
          rows={1}
          disabled={disabled}
          aria-label={ariaLabel}
        />
        <div className="flex items-center justify-end px-3 pb-2.5">
          <Button
            type="submit"
            size="icon-lg"
            disabled={disabled || !value.trim()}
            className="shrink-0"
            aria-label={sendLabel}
          >
            <ArrowUp size={18} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  );
}
