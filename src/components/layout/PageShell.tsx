import * as React from "react";

import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { cn } from "@/lib/utils";

const WIDTH_CLASS = {
  "3xl": "max-w-3xl",
  "5xl": "max-w-5xl",
} as const;

interface PageShellProps {
  children: React.ReactNode;
  /** Reading width of the main column. Defaults to the prose width. */
  width?: keyof typeof WIDTH_CLASS;
  className?: string;
}

/**
 * Standard chrome for static content pages: sticky Header, the single
 * main-content column (with bottom padding that clears the
 * mobile nav), and the Footer.
 */
export function PageShell({
  children,
  width = "3xl",
  className,
}: PageShellProps) {
  return (
    <>
      <Header />
      <main
        id="main-content"
        className={cn(
          "mx-auto px-4 py-10 pb-24 sm:pb-10 sm:px-6 md:px-8",
          WIDTH_CLASS[width],
          className,
        )}
      >
        {children}
      </main>
      <Footer />
    </>
  );
}
