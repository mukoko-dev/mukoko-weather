/**
 * Tests for ExploreChatbot component — validates structure, state management,
 * accessibility, and UI patterns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "ExploreChatbot.tsx"), "utf-8");

describe("ExploreChatbot component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports the ExploreChatbot component", () => {
    expect(source).toContain("export function ExploreChatbot");
  });

  it("imports useAppStore for user activity preferences", () => {
    expect(source).toContain("useAppStore");
    expect(source).toContain("selectedActivities");
  });

  it("uses ReactMarkdown for assistant messages", () => {
    expect(source).toContain("import ReactMarkdown");
    expect(source).toContain("<ReactMarkdown");
  });

  it("wraps ReactMarkdown in error boundary for crash isolation", () => {
    expect(source).toContain("MarkdownErrorBoundary");
    expect(source).toContain("<MarkdownErrorBoundary");
    expect(source).toContain("getDerivedStateFromError");
  });

  it("falls back to raw text content when markdown rendering fails", () => {
    // The error boundary receives message.content as fallback prop
    expect(source).toContain("fallback={message.content}");
  });
});

describe("state management", () => {
  it("tracks messages as ChatMessage array", () => {
    expect(source).toContain("useState<ChatMessage[]>([])");
  });

  it("tracks loading state", () => {
    expect(source).toContain("useState(false)");
    expect(source).toContain("setLoading(true)");
    expect(source).toContain("setLoading(false)");
  });

  it("tracks input text", () => {
    expect(source).toContain('useState("")');
    expect(source).toContain('setInput("")');
  });

  it("clears input after sending", () => {
    expect(source).toContain('setInput("")');
  });
});

describe("sendMessage logic", () => {
  it("trims whitespace before sending", () => {
    expect(source).toContain("text.trim()");
  });

  it("prevents sending when loading", () => {
    expect(source).toContain("!trimmed || loading");
  });

  it("prevents sending empty messages", () => {
    expect(source).toContain("!trimmed || loading");
  });

  it("sends message to /api/explore", () => {
    expect(source).toContain('fetch("/api/explore"');
  });

  it("includes history and activities in request body", () => {
    expect(source).toContain("message: trimmed");
    expect(source).toContain("history");
    expect(source).toContain("activities: selectedActivities");
  });

  it("builds history from previous messages (sliced to last 10)", () => {
    expect(source).toContain("messages.slice(-10).map((m) => ({");
    expect(source).toContain("role: m.role");
    expect(source).toContain("content: m.content");
  });
});

describe("error handling", () => {
  it("shows fallback error message on fetch failure", () => {
    expect(source).toContain("having trouble connecting");
  });

  it("adds error as assistant message (not crash)", () => {
    expect(source).toContain('role: "assistant"');
    expect(source).toContain("errorMessage");
  });

  it("resets loading state in finally block", () => {
    expect(source).toContain("} finally {");
    expect(source).toContain("setLoading(false)");
  });

  it("refocuses input after response", () => {
    expect(source).toContain("inputRef.current?.focus()");
  });
});

describe("suggested prompts", () => {
  it("defines SUGGESTED_PROMPTS array", () => {
    expect(source).toContain("const SUGGESTED_PROMPTS");
  });

  it("shows EmptyState when no messages", () => {
    expect(source).toContain("messages.length === 0");
    expect(source).toContain("<EmptyState");
  });

  it("triggers sendMessage on suggestion click", () => {
    expect(source).toContain("onSuggestionClick(prompt.query)");
  });

  it("suggestion buttons meet 44px touch target", () => {
    expect(source).toContain("min-h-[44px]");
  });
});

describe("accessibility", () => {
  it("has aria-live region for messages", () => {
    expect(source).toContain('aria-live="polite"');
  });

  it("has aria-relevant for additions", () => {
    expect(source).toContain('aria-relevant="additions"');
  });

  it("input has aria-label", () => {
    expect(source).toContain('aria-label="Ask Shamwari Explorer"');
  });

  it("send button has aria-label", () => {
    expect(source).toContain('aria-label="Send message"');
  });

  it("typing indicator has role=status", () => {
    expect(source).toContain('role="status"');
  });

  it("typing indicator has sr-only text", () => {
    expect(source).toContain("sr-only");
    expect(source).toContain("Shamwari Explorer is thinking");
  });

  it("decorative SVGs are aria-hidden", () => {
    expect(source).toContain('aria-hidden="true"');
  });
});

describe("location references", () => {
  it("renders location links from references", () => {
    expect(source).toContain("message.references");
    expect(source).toContain("ref.slug");
  });

  it("filters for location and weather reference types", () => {
    expect(source).toContain('"location"');
    expect(source).toContain('"weather"');
  });

  it("limits displayed references to 5", () => {
    expect(source).toContain(".slice(0, 5)");
  });

  it("uses MapPinIcon for reference links", () => {
    expect(source).toContain("<MapPinIcon");
  });
});

describe("memory management", () => {
  it("defines MAX_RENDERED_MESSAGES cap", () => {
    expect(source).toContain("MAX_RENDERED_MESSAGES");
  });

  it("caps messages when adding user message", () => {
    // All three setMessages calls should slice to cap
    const sliceCalls = source.match(/\.slice\(-MAX_RENDERED_MESSAGES\)/g);
    expect(sliceCalls).not.toBeNull();
    expect(sliceCalls!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("markdown link sanitisation", () => {
  it("defines isSafeHref function for href validation", () => {
    expect(source).toContain("function isSafeHref");
  });

  it("allows relative paths starting with /", () => {
    expect(source).toContain('href.startsWith("/")');
  });

  it("allows anchor links starting with #", () => {
    expect(source).toContain('href.startsWith("#")');
  });

  it("allows https and http protocols via URL constructor", () => {
    expect(source).toContain('url.protocol === "https:"');
    expect(source).toContain('url.protocol === "http:"');
  });

  it("renders unsafe links as plain <span> text", () => {
    expect(source).toContain("<span>{children}</span>");
  });

  it("passes custom components to ReactMarkdown", () => {
    expect(source).toContain("components={markdownComponents}");
  });

  it("adds rel=noopener noreferrer and target=_blank to safe links", () => {
    expect(source).toContain('rel="noopener noreferrer"');
    expect(source).toContain('target="_blank"');
  });
});

describe("isSafeHref behavioral tests", () => {
  // Mirror of the isSafeHref helper in ExploreChatbot.tsx
  function isSafeHref(href: string | undefined): boolean {
    if (!href) return false;
    if (href.startsWith("/") || href.startsWith("#")) return true;
    try {
      const url = new URL(href);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }

  it("blocks javascript: URIs", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
  });

  it("blocks data: URIs", () => {
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("blocks vbscript: URIs", () => {
    expect(isSafeHref("vbscript:MsgBox('XSS')")).toBe(false);
  });

  it("allows https URLs", () => {
    expect(isSafeHref("https://weather.mukoko.com/harare")).toBe(true);
  });

  it("allows http URLs", () => {
    expect(isSafeHref("http://example.com")).toBe(true);
  });

  it("allows relative paths", () => {
    expect(isSafeHref("/harare")).toBe(true);
  });

  it("allows anchor links", () => {
    expect(isSafeHref("#section")).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isSafeHref(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSafeHref("")).toBe(false);
  });
});

describe("rate limit error surfacing", () => {
  it("reads response body before throwing on non-ok responses", () => {
    expect(source).toContain("res.json().catch(() => null)");
  });

  it("extracts response or error message from body", () => {
    expect(source).toContain("body?.response ?? body?.error");
  });

  it("uses server error message when available instead of generic fallback", () => {
    expect(source).toContain("err instanceof Error && err.message");
  });
});

describe("UI patterns", () => {
  it("disables input while loading", () => {
    expect(source).toContain("disabled={loading}");
  });

  it("disables send button when empty or loading", () => {
    expect(source).toContain("disabled={loading || !input.trim()}");
  });

  it("uses form submission pattern", () => {
    expect(source).toContain("onSubmit={handleSubmit}");
    expect(source).toContain("e.preventDefault()");
  });

  it("auto-scrolls to bottom on new messages", () => {
    expect(source).toContain("scrollIntoView");
    expect(source).toContain("messagesEndRef");
  });

  it("uses global styles (no hardcoded colors)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });
});
