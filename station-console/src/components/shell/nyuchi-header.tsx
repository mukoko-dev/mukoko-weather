"use client";

// ── INFRASTRUCTURE HARNESS (auto-wired) ──
// Every brand component participates in observability, motion, a11y,
// and health monitoring via the harness. Zero manual config.
import { useNyuchiHarness } from "@/lib/harness";

import * as React from "react";
import { cn } from "@/lib/utils";
import { NyuchiLogo } from "@/components/brand/nyuchi-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { ExternalLink } from "@/lib/icons";

/* ═══════════════════════════════════════════════════════════════
   NYUCHI HEADER — Brand Shell Component
   Vendored from the Mzizi registry (mzizi.dev/components/nyuchi-header).
   Console adaptation: no sidebar in this app, so the SidebarTrigger
   slot is omitted; everything else follows the registry source.
   ═══════════════════════════════════════════════════════════════ */

export interface NavItem {
  label: string;
  href: string;
  external?: boolean;
}

interface NyuchiHeaderProps {
  /** App name displayed after the ecosystem logo */
  appName?: string;
  /** Desktop navigation items */
  navItems?: NavItem[];
  /** Right-side action slot */
  actions?: React.ReactNode;
  /** Whether header has scrolled (enables blur background) */
  scrolled?: boolean;
  className?: string;
}

export function NyuchiHeader({
  appName,
  navItems = [],
  actions,
  scrolled = true,
  className,
}: NyuchiHeaderProps) {
  const { LiveRegion } = useNyuchiHarness("header");

  return (
    <header
      data-slot="nyuchi-header"
      data-portal="https://mzizi.dev/components/nyuchi-header"
      className={cn(
        "sticky top-0 z-50 flex h-14 items-center gap-2 px-5 transition-all duration-300",
        scrolled
          ? "border-b border-border/50 bg-background/80 backdrop-blur-xl"
          : "bg-transparent",
        className,
      )}
    >
      {LiveRegion}

      {/* Left: logo */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <a href="/" className="flex items-center gap-3">
          <NyuchiLogo size={20} suffix={appName} />
        </a>
      </div>

      {/* Navigation */}
      <nav className="ml-6 flex items-center gap-1">
        {navItems.map((item) => (
          <a
            key={item.href}
            href={item.href}
            target={item.external ? "_blank" : undefined}
            rel={item.external ? "noopener noreferrer" : undefined}
            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary hover:text-foreground"
          >
            {item.label}
            {item.external && <ExternalLink className="size-3 opacity-50" />}
          </a>
        ))}
      </nav>

      {/* Actions area */}
      <div className="flex items-center gap-1">
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}
