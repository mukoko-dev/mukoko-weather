"use client";

/**
 * Three bouncing dots signalling that an AI reply is in flight.
 * Bounce is gated behind `motion-safe:` so reduced-motion users see static dots.
 */

const DOT_DELAYS = [
  "",
  "motion-safe:[animation-delay:150ms]",
  "motion-safe:[animation-delay:300ms]",
];

interface TypingDotsProps {
  /** Screen-reader announcement, read inside the role="status" region. */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

export function TypingDots({
  label = "Thinking...",
  size = "md",
  className,
}: TypingDotsProps) {
  const dotSize = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2";
  return (
    <div
      role="status"
      aria-label={label}
      className={`flex items-center gap-1 py-2 ${className ?? ""}`.trim()}
    >
      {DOT_DELAYS.map((delay, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`${dotSize} motion-safe:animate-bounce rounded-full bg-text-tertiary ${delay}`.trim()}
        />
      ))}
    </div>
  );
}
