"use client";

/**
 * Mzizi component harness — vendored from the Mzizi registry
 * (`npx shadcn@latest add https://api.mzizi.dev/v1/ui/mzizi-harness`,
 * components/registry/n3-brand/mzizi-harness.tsx). Keep it in step with
 * upstream: behaviour changes go to mzizi-dev/mzizi-registry first.
 *
 * Gives brand, safety and resilience components scoped logging, motion
 * (reduced-motion aware) and an accessible shared live region. Primitives
 * never import it.
 *
 * Local changes from upstream: the motion config is read through
 * `useSyncExternalStore` so it follows a live `prefers-reduced-motion`
 * change and server and client agree on first render, and the console
 * logger carries no lint suppressions (this repo's lint allows console).
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export interface ScopedLogger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (
    message: string,
    error?: Error,
    data?: Record<string, unknown>,
  ) => void;
}

function createScopedLogger(name: string): ScopedLogger {
  const prefix = `[mzizi:${name}]`;
  return {
    debug: (m, d) => console.debug(prefix, m, d ?? ""),
    info: (m, d) => console.info(prefix, m, d ?? ""),
    warn: (m, d) => console.warn(prefix, m, d ?? ""),
    error: (m, e, d) => console.error(prefix, m, e ?? "", d ?? ""),
  };
}

export interface MotionConfig {
  prefersReduced: boolean;
  enterDuration: number;
  exitDuration: number;
  enterEasing: string;
  exitEasing: string;
  staggerDelay: (index: number) => number;
}

/** Motion settings for a reduced-motion preference. Pure, for tests. */
export function motionConfigFor(prefersReduced: boolean): MotionConfig {
  return {
    prefersReduced,
    enterDuration: prefersReduced ? 0 : 200,
    exitDuration: prefersReduced ? 0 : 100,
    enterEasing: prefersReduced ? "linear" : "cubic-bezier(0, 0, 0.2, 1)",
    exitEasing: prefersReduced ? "linear" : "cubic-bezier(0.4, 0, 1, 1)",
    staggerDelay: (index: number) =>
      prefersReduced ? 0 : Math.min(index, 8) * 50,
  };
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function readReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia
    ? window.matchMedia(REDUCED_QUERY).matches
    : false;
}

/** Shared screen-reader live region, created once per document. */
export const LIVE_REGION_ID = "nyuchi-live-region";

function useAnnouncer() {
  const regionRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    let el = document.getElementById(LIVE_REGION_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = LIVE_REGION_ID;
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.setAttribute("aria-atomic", "true");
      el.className = "sr-only";
      document.body.appendChild(el);
    }
    regionRef.current = el;
  }, []);
  const say = React.useCallback(
    (message: string, politeness: "polite" | "assertive") => {
      const el = regionRef.current;
      if (!el) return;
      el.setAttribute("aria-live", politeness);
      el.textContent = "";
      requestAnimationFrame(() => {
        el.textContent = message;
      });
    },
    [],
  );
  const announce = React.useCallback((m: string) => say(m, "polite"), [say]);
  const announceUrgent = React.useCallback(
    (m: string) => say(m, "assertive"),
    [say],
  );
  const LiveRegion = React.useMemo(
    () => <span className="sr-only" aria-hidden="true" />,
    [],
  );
  return { announce, announceUrgent, LiveRegion };
}

export interface ComponentHarnessResult {
  log: ScopedLogger;
  motion: MotionConfig;
  announce: (message: string) => void;
  announceUrgent: (message: string) => void;
  LiveRegion: React.ReactNode;
}

export function useMziziHarness(componentName: string): ComponentHarnessResult {
  const log = React.useMemo(
    () => createScopedLogger(componentName),
    [componentName],
  );
  const prefersReduced = React.useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    () => false,
  );
  const motion = React.useMemo(
    () => motionConfigFor(prefersReduced),
    [prefersReduced],
  );
  const { announce, announceUrgent, LiveRegion } = useAnnouncer();
  React.useEffect(() => {
    log.debug("mounted");
    return () => log.debug("unmounted");
  }, [log]);
  return { log, motion, announce, announceUrgent, LiveRegion };
}

export interface MziziHarnessProps {
  name: string;
  children: React.ReactNode;
  loading?: boolean;
  skeleton?: React.ReactNode;
  fallback?: React.ReactNode;
  className?: string;
}

interface BoundaryState {
  hasError: boolean;
}

class HarnessBoundary extends React.Component<
  { name: string; fallback?: React.ReactNode; children: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { hasError: false };
  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    createScopedLogger(this.props.name).error("section crashed", error);
  }
  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div
            role="alert"
            className="flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-border bg-surface-card p-6 text-center text-sm text-text-secondary"
          >
            This section could not be displayed.
          </div>
        )
      );
    }
    return this.props.children;
  }
}

export function MziziHarness({
  name,
  children,
  loading = false,
  skeleton,
  fallback,
  className,
}: MziziHarnessProps) {
  if (loading) {
    return (
      <div
        data-slot="mzizi-harness"
        data-loading
        role="status"
        className={className}
      >
        {skeleton ?? <div className="chameleon h-32" aria-label="Loading" />}
      </div>
    );
  }
  return (
    <div
      data-slot="mzizi-harness"
      data-portal="https://mzizi.dev/components/mzizi-harness"
      className={cn(className)}
    >
      <HarnessBoundary name={name} fallback={fallback}>
        {children}
      </HarnessBoundary>
    </div>
  );
}
