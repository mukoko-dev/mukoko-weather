"use client";

import Link from "next/link";
import { SparklesIcon, MapPinIcon } from "@/lib/weather-icons";
import { useAppStore, type ShamwariContext } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";

export type ShamwariCTAVariant = "tanzanite" | "primary" | "subtle" | "text";

const VARIANT_CLASSES: Record<ShamwariCTAVariant, string> = {
  tanzanite:
    "inline-flex items-center gap-1.5 rounded-[var(--radius-badge)] bg-tanzanite px-4 py-2 text-base font-medium text-mineral-tanzanite-fg transition-colors hover:bg-tanzanite/90 min-h-[var(--touch-target-min)]",
  primary:
    "inline-flex items-center gap-1 rounded-[var(--radius-input)] bg-primary px-3 py-2 text-base font-medium text-primary-foreground transition-colors hover:bg-primary/90 min-h-[var(--touch-target-min)]",
  subtle:
    "press-scale inline-flex items-center gap-1.5 rounded-[var(--radius-input)] bg-primary/10 px-4 py-2 text-base font-medium text-primary transition-all hover:bg-primary/20 min-h-[var(--touch-target-min)]",
  text: "inline-flex items-center gap-1 text-base text-text-tertiary transition-colors hover:text-tanzanite",
};

const VARIANT_ICON_SIZE: Record<ShamwariCTAVariant, number> = {
  tanzanite: 14,
  primary: 12,
  subtle: 14,
  text: 10,
};

export interface ShamwariCTAProps {
  /** Context handed off to /shamwari on click — timestamp is stamped by the store */
  context: Omit<ShamwariContext, "timestamp">;
  label: string;
  variant?: ShamwariCTAVariant;
  icon?: "sparkles" | "map-pin";
  className?: string;
}

/**
 * Shared "continue this conversation in Shamwari" link. Centralizes the
 * feature-flag gate + setShamwariContext handoff previously hand-rolled in
 * AISummaryChat, HistoryAnalysis, and ExploreSearch. Renders nothing while
 * FLAGS.shamwari_chat is off.
 */
export function ShamwariCTA({
  context,
  label,
  variant = "primary",
  icon = "sparkles",
  className,
}: ShamwariCTAProps) {
  const setShamwariContext = useAppStore((s) => s.setShamwariContext);

  if (!isFeatureEnabled("shamwari_chat")) return null;

  const Icon = icon === "map-pin" ? MapPinIcon : SparklesIcon;

  return (
    <Link
      href="/shamwari"
      onClick={() => setShamwariContext(context)}
      className={[VARIANT_CLASSES[variant], className].filter(Boolean).join(" ")}
    >
      <Icon size={VARIANT_ICON_SIZE[variant]} />
      {label}
    </Link>
  );
}
