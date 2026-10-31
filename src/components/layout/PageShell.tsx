import * as React from "react";

import { Breadcrumb, BreadcrumbSkeleton } from "@/components/layout/Breadcrumb";
import type { BreadcrumbItem } from "@/components/layout/Breadcrumb";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";
import { cn } from "@/lib/utils";

/**
 * Page layouts, named as Mzizi's `mzizi-page` names them (N6): a feed or
 * settings page reads at 2xl, a detail page at 4xl, a dashboard at 7xl.
 * `prose` (3xl) and `wide` (5xl) are the two long-form widths static pages use.
 */
const WIDTH_CLASS = {
  feed: "max-w-2xl",
  settings: "max-w-2xl",
  prose: "max-w-3xl",
  detail: "max-w-4xl",
  wide: "max-w-5xl",
  dashboard: "max-w-7xl",
} as const;

/** The one main-column recipe: width, side gutters and the bottom padding that clears the mobile nav. */
const MAIN_CLASS =
  "mx-auto w-full px-4 py-8 pb-[var(--mobile-nav-clearance)] sm:px-6 sm:pb-8 md:px-8";

type Width = keyof typeof WIDTH_CLASS;

interface PageShellProps {
  children: React.ReactNode;
  /** Reading width of the main column. Defaults to the prose width. */
  width?: Width;
  /** Home / ... trail shown between the header and the main column. */
  breadcrumb?: BreadcrumbItem[];
  className?: string;
}

/**
 * Standard chrome for every ordinary page: the header (the root layout owns
 * the real one; see AppChrome), an optional breadcrumb, the single
 * main-content column (with the bottom padding that clears the mobile nav),
 * and the Footer. A page that needs a different width, spacing or landmark
 * should extend this, not hand-roll `<main>`.
 */
export function PageShell({
  children,
  width = "prose",
  breadcrumb,
  className,
}: PageShellProps) {
  return (
    <>
      <Header />
      {breadcrumb && (
        <Breadcrumb className={WIDTH_CLASS[width]} items={breadcrumb} />
      )}
      <main
        id="main-content"
        className={cn(MAIN_CLASS, WIDTH_CLASS[width], className)}
      >
        {children}
      </main>
      <Footer />
    </>
  );
}

/**
 * The loading twin of PageShell: the same header slot, breadcrumb slot, main
 * column and footer, so a loader and its page share one frame and nothing
 * moves when the content streams in.
 */
export function PageShellSkeleton({
  children,
  width = "prose",
  breadcrumb = false,
  label = "Loading",
  className,
}: {
  children: React.ReactNode;
  width?: Width;
  /** Reserve the breadcrumb row. */
  breadcrumb?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <>
      <HeaderSkeleton />
      {breadcrumb && <BreadcrumbSkeleton className={WIDTH_CLASS[width]} />}
      <main
        id="main-content"
        role="status"
        aria-label={label}
        className={cn(MAIN_CLASS, WIDTH_CLASS[width], className)}
      >
        {children}
      </main>
      <Footer />
    </>
  );
}
