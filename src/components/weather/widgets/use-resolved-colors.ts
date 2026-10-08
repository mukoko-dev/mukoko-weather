"use client";

import * as React from "react";
import { resolveColor } from "@/components/ui/chart";

/**
 * Resolve CSS custom-property references to concrete colours for SVG paint
 * servers (stop-color cannot consume var() reliably). Hydration-safe: the
 * server and first client render both use the neutral `currentColor`
 * placeholder; the real colours are applied in a layout effect before paint.
 * Re-resolves when `data-theme` changes.
 */
export function useResolvedColors(tokens: string[]): string[] {
  const key = tokens.join(",");
  const [colors, setColors] = React.useState<string[]>(() =>
    tokens.map(() => "currentColor"),
  );

  React.useLayoutEffect(() => {
    const resolve = () => setColors(key.split(",").map(resolveColor));
    resolve();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [key]);

  return colors;
}
