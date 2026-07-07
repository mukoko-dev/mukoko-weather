"use client";

// ── INFRASTRUCTURE HARNESS (auto-wired) ──────────────────
import { useNyuchiHarness } from "@/lib/harness";

import * as React from "react";
import { cn } from "@/lib/utils";
import { NyuchiLogo } from "@/components/brand/nyuchi-logo";

/* ═══════════════════════════════════════════════════════════════
   NYUCHI FOOTER — Brand Shell Component
   Vendored from the Mzizi registry (mzizi.dev/components/nyuchi-footer).
   Console adaptations: the mineral identity dots render all SEVEN
   minerals via token-backed classes (the brand ribbon itself is the
   fixed VERTICAL .minerals-stripe on the viewport edge — never a
   horizontal strip), and links open per-item like the registry source.
   ═══════════════════════════════════════════════════════════════ */

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

interface FooterSection {
  title: string;
  links: FooterLink[];
}

interface NyuchiFooterProps {
  sections?: FooterSection[];
  companyName?: string;
  tagline?: string;
  className?: string;
}

const MINERAL_DOTS = [
  "bg-tanzanite",
  "bg-cobalt",
  "bg-gold",
  "bg-malachite",
  "bg-copper",
  "bg-sodalite",
  "bg-terracotta",
] as const;

export function NyuchiFooter({
  sections = [],
  companyName = "Nyuchi Africa",
  tagline = "I am because we are.",
  className,
}: NyuchiFooterProps) {
  // ── L4: HARNESS — Observability + motion + a11y ──
  const { motion, LiveRegion } = useNyuchiHarness("footer");

  // ── L6: I18N — Dynamic year via Intl-safe method ──
  const year = new Date().getFullYear();

  // ── L2: MOTION — Fade in animation ──
  const animStyle = React.useMemo(() => {
    if (motion.prefersReduced) return {};
    return {
      animation: `nyuchi-fade-slide-up ${motion.enterDuration}ms ${motion.enterEasing} both`,
    };
  }, [motion]);

  return (
    <footer
      data-slot="nyuchi-footer"
      data-portal="https://mzizi.dev/components/nyuchi-footer"
      role="contentinfo"
      className={cn("border-t border-border bg-card", className)}
      style={animStyle}
    >
      {LiveRegion}

      <div className="mx-auto max-w-7xl px-5 py-10">
        {/* Link sections grid */}
        <div className="grid grid-cols-2 gap-8 md:grid-cols-3 lg:grid-cols-4">
          {/* Brand column */}
          <div className="col-span-2 md:col-span-1">
            <NyuchiLogo size={22} suffix="weather stations" />
            {tagline && (
              <p className="mt-3 font-sans text-sm italic text-muted-foreground">
                {tagline}
              </p>
            )}
          </div>

          {/* L5: RESILIENCE — Guard against empty sections */}
          {(sections ?? []).map((section) => (
            <div key={section.title}>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h4>
              <nav
                className="mt-3 flex flex-col gap-2"
                aria-label={section.title}
              >
                {(section.links ?? []).map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target={link.external ? "_blank" : undefined}
                    rel={link.external ? "noopener noreferrer" : undefined}
                    className={cn(
                      "text-sm text-muted-foreground transition-colors hover:text-cobalt",
                      /* L3: A11Y — Focus ring tokens + min touch target */
                      "flex min-h-12 items-center rounded-md",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    )}
                  >
                    {link.label}
                  </a>
                ))}
              </nav>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-10 flex flex-col items-center justify-between gap-2 border-t border-border pt-6 md:flex-row">
          <p className="text-xs text-muted-foreground">
            &copy; {year} {companyName}. All rights reserved.
          </p>
          {/* L1: TOKENS — Seven African Minerals dots */}
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {MINERAL_DOTS.map((cls) => (
              <span key={cls} className={cn("size-1.5 rounded-full", cls)} />
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
