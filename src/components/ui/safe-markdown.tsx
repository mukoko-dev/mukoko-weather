"use client";

import {
  Component,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Error boundary — malformed markdown must never crash the surrounding chat
// or summary UI. Falls back to the raw text as a plain paragraph.
// ---------------------------------------------------------------------------

interface MarkdownErrorBoundaryState {
  hasError: boolean;
}

class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallback: string },
  MarkdownErrorBoundaryState
> {
  state: MarkdownErrorBoundaryState = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <p className="text-base text-text-secondary">{this.props.fallback}</p>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Link sanitisation — only relative paths, fragments and https:// URLs are
// rendered as links. javascript:, data:, vbscript:, and http: fall back to
// plain text.
// ---------------------------------------------------------------------------

export function isSafeHref(href: string | undefined): boolean {
  if (!href) return false;
  if (href.startsWith("/") || href.startsWith("#")) return true;
  try {
    const url = new URL(href);
    // Only allow https: — http: could enable link injection to plaintext targets.
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

const markdownComponents = {
  a: ({
    href,
    children,
    ...props
  }: ComponentPropsWithoutRef<"a"> & { href?: string }) => {
    if (!isSafeHref(href)) {
      // Render unsafe links as plain text — no clickable element
      return <span>{children}</span>;
    }
    return (
      <a href={href} rel="noopener noreferrer" target="_blank" {...props}>
        {children}
      </a>
    );
  },
};

// ---------------------------------------------------------------------------
// SafeMarkdown — sanitised, error-isolated markdown rendering with the shared
// prose styling used by every AI surface.
// ---------------------------------------------------------------------------

const PROSE_BASE =
  "prose prose-base max-w-none text-text-secondary prose-strong:text-text-primary prose-headings:text-text-primary prose-li:marker:text-text-tertiary";
const PROSE_SM =
  "prose prose-sm max-w-none text-text-secondary prose-strong:text-text-primary prose-headings:text-text-primary prose-li:marker:text-text-tertiary";

interface SafeMarkdownProps {
  content: string;
  size?: "base" | "sm";
  className?: string;
}

export function SafeMarkdown({
  content,
  size = "base",
  className,
}: SafeMarkdownProps) {
  return (
    <MarkdownErrorBoundary fallback={content}>
      <div className={cn(size === "sm" ? PROSE_SM : PROSE_BASE, className)}>
        <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
}
