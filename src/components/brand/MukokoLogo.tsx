"use client";

import Image from "next/image";
import { useAppStore } from "@/lib/store";

/**
 * Mukoko brand mark — official Seed of Life icon + "weather" wordmark.
 * Uses the brand kit SVGs (logo-light.svg / logo-dark.svg) from /public.
 * Theme-aware: switches between light and dark variant automatically.
 */
export function MukokoLogo({ className = "" }: { className?: string }) {
  const theme = useAppStore((s) => s.theme);

  // Resolve system theme at render time
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const src = isDark ? "/logo-dark.svg" : "/logo-light.svg";

  return (
    <span
      className={`inline-flex items-center gap-2 ${className}`}
      aria-label="mukoko weather"
    >
      <Image
        src={src}
        alt="mukoko mark"
        width={32}
        height={32}
        className="h-8 w-8 shrink-0"
        priority
      />
      <span className="font-heading font-bold tracking-tight text-text-primary leading-none">
        weather
      </span>
    </span>
  );
}
