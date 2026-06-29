"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

/**
 * Mukoko brand mark — full 7-mineral Seed of Life icon + "weather" wordmark.
 *
 * Uses the official brand kit SVGs (logo-light.svg / logo-dark.svg).
 * Defaults to the light variant for SSR; switches client-side to match
 * the active theme by watching the data-theme attribute on <html>.
 */
export function MukokoLogo({ className = "" }: { className?: string }) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const html = document.documentElement;

    const update = () => setIsDark(html.dataset.theme === "dark");
    update();

    const observer = new MutationObserver(update);
    observer.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <span
      className={`inline-flex items-center gap-2 ${className}`}
      aria-label="mukoko weather"
    >
      <Image
        src={isDark ? "/logo-dark.svg" : "/logo-light.svg"}
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
