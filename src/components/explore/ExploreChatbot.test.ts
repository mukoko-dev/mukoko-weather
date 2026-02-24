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

  it("sends message to /api/py/chat", () => {
    expect(source).toContain('fetch("/api/py/chat"');
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
  it("defines DEFAULT_SUGGESTED_PROMPTS array", () => {
    expect(source).toContain("const DEFAULT_SUGGESTED_PROMPTS");
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

describe("contextual navigation (ShamwariContext)", () => {
  it("imports isShamwariContextValid and ShamwariContext from store", () => {
    expect(source).toContain("isShamwariContextValid");
    expect(source).toContain("ShamwariContext");
  });

  it("reads shamwariContext from store", () => {
    expect(source).toContain("shamwariContext");
    expect(source).toContain("clearShamwariContext");
  });

  it("generates contextual greeting based on source type", () => {
    expect(source).toContain("getContextualGreeting");
    expect(source).toContain('source === "location"');
    expect(source).toContain('source === "history"');
    expect(source).toContain('source === "explore"');
  });

  it("generates contextual prompts based on source type", () => {
    expect(source).toContain("getContextualPrompts");
    expect(source).toContain("contextualPrompts");
  });

  it("clears context after consumption (one-time use)", () => {
    expect(source).toContain("clearShamwariContext()");
  });

  it("shows contextual prompt buttons after greeting message", () => {
    expect(source).toContain("contextualPrompts && contextualPrompts.length > 0");
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

  it("allows only https protocol via URL constructor", () => {
    expect(source).toContain('url.protocol === "https:"');
    // http: is intentionally not allowed — prevents link injection to plaintext targets
    expect(source).not.toContain('url.protocol === "http:"');
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
      return url.protocol === "https:";
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

  it("blocks http URLs (only https allowed)", () => {
    expect(isSafeHref("http://example.com")).toBe(false);
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

describe("overflow containment", () => {
  it("prevents horizontal overflow on the chat container", () => {
    expect(source).toContain("overflow-hidden");
    expect(source).toContain("overflow-x-hidden");
  });

  it("uses break-words on user message text", () => {
    expect(source).toContain("break-words");
  });

  it("uses min-w-0 on message bubble flex containers", () => {
    expect(source).toContain("min-w-0");
  });

  it("constrains markdown prose content overflow", () => {
    expect(source).toContain("prose-pre:overflow-x-auto");
    expect(source).toContain("prose-pre:max-w-full");
    // Uses break-words (not break-all) for inline code to avoid splitting mid-word
    expect(source).toContain("prose-code:break-words");
    expect(source).not.toContain("prose-code:break-all");
  });

  it("wraps textarea in a card-style container", () => {
    expect(source).toContain("rounded-2xl border border-border bg-surface-card");
  });
});

describe("message layout", () => {
  it("user messages are in right-aligned bubbles with primary bg", () => {
    expect(source).toContain("justify-end");
    expect(source).toContain("bg-primary text-primary-foreground");
  });

  it("assistant messages are full-width without bubble background", () => {
    // Assistant messages should have a sparkles icon + full-width prose, no bg-surface-card on message
    expect(source).toContain("SparklesIcon");
    expect(source).toContain("flex-1");
  });

  it("assistant messages show a sparkles avatar icon", () => {
    expect(source).toContain("rounded-full bg-primary/10");
    expect(source).toContain("SparklesIcon");
  });

  it("typing indicator matches assistant message layout with sparkles icon", () => {
    // Typing indicator should also use the sparkles icon layout
    const typingSection = source.slice(source.indexOf("function TypingIndicator"));
    expect(typingSection).toContain("SparklesIcon");
    expect(typingSection).toContain("rounded-full bg-primary/10");
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests for pure helper functions (mirrored from source)
// ---------------------------------------------------------------------------

// Mirror of getContextualGreeting from ExploreChatbot.tsx
function getContextualGreeting(ctx: { source: string; locationName?: string; temperature?: number; weatherSummary?: string; historyDays?: number; exploreQuery?: string }): string | null {
  if (ctx.source === "location" && ctx.locationName) {
    const tempInfo = ctx.temperature != null ? ` at ${Math.round(ctx.temperature)}°C` : "";
    const summaryInfo = ctx.weatherSummary
      ? (() => {
          const s = ctx.weatherSummary;
          if (s.length <= 150) return ` ${s}`;
          const idx = s.lastIndexOf(" ", 150);
          const truncated = idx > 0 ? s.slice(0, idx) : s.slice(0, 150);
          return ` ${truncated}...`;
        })()
      : "";
    return `You're looking at weather in **${ctx.locationName}**${tempInfo}.${summaryInfo} How can I help you plan around this weather?`;
  }
  if (ctx.source === "history" && ctx.locationName) {
    return `You were analyzing ${ctx.historyDays || 30}-day weather history for **${ctx.locationName}**. Want me to dive deeper into any trends or help plan around what the data shows?`;
  }
  if (ctx.source === "explore" && ctx.exploreQuery) {
    return `You searched for "${ctx.exploreQuery}". I can help you explore more locations or get detailed weather for any of the results. What would you like to know?`;
  }
  return null;
}

// Mirror of getContextualPrompts from ExploreChatbot.tsx
function getContextualPrompts(ctx: { source: string; locationName?: string; historyDays?: number; exploreQuery?: string }): { label: string; query: string }[] {
  const loc = ctx.locationName || "this location";
  if (ctx.source === "location") {
    return [
      { label: `More about ${loc}`, query: `Tell me more about the weather in ${loc}` },
      { label: "Activity advice", query: `What activities are best for today's weather in ${loc}?` },
      { label: "Compare locations", query: `Compare ${loc} weather with nearby cities` },
    ];
  }
  if (ctx.source === "history") {
    return [
      { label: "Explain trends", query: `What do the weather trends in ${loc} over the last ${ctx.historyDays || 30} days tell us?` },
      { label: "Farming impact", query: `How have recent weather patterns affected farming in ${loc}?` },
      { label: "Future outlook", query: `Based on recent history, what should I expect next in ${loc}?` },
    ];
  }
  if (ctx.source === "explore") {
    return [
      { label: "Refine search", query: ctx.exploreQuery ? `Show me more locations like "${ctx.exploreQuery}"` : `What other locations have similar weather?` },
      { label: "Detailed comparison", query: `Compare the weather conditions of locations you found` },
      { label: "Best option", query: `Which location is best for outdoor activities right now?` },
    ];
  }
  // Falls through to DEFAULT_SUGGESTED_PROMPTS in the real component
  return [];
}

describe("getContextualGreeting behavioral tests", () => {
  it("returns greeting with location name for source=location", () => {
    const result = getContextualGreeting({ source: "location", locationName: "Harare" });
    expect(result).toContain("**Harare**");
    expect(result).toContain("How can I help");
  });

  it("includes rounded temperature when provided", () => {
    const result = getContextualGreeting({ source: "location", locationName: "Harare", temperature: 25.7 });
    expect(result).toContain("at 26°C");
  });

  it("omits temperature when not provided", () => {
    const result = getContextualGreeting({ source: "location", locationName: "Harare" });
    expect(result).not.toContain("°C");
  });

  it("includes short summaries without truncation", () => {
    const result = getContextualGreeting({ source: "location", locationName: "Harare", weatherSummary: "Clear skies expected." });
    expect(result).toContain("Clear skies expected.");
    expect(result).not.toContain("...");
  });

  it("truncates long summaries at a word boundary", () => {
    const longSummary = "The weather today is expected to be warm and sunny with clear skies throughout the afternoon. Temperatures will remain above average for this time of year, making it an excellent day for outdoor activities and farming operations in the region.";
    const result = getContextualGreeting({ source: "location", locationName: "Harare", weatherSummary: longSummary })!;
    expect(result).toContain("...");
    // Extract the summary portion between the period after location and "..."
    const afterLocation = result.indexOf(".");
    const ellipsis = result.indexOf("...");
    const summaryText = result.slice(afterLocation + 1, ellipsis).trim();
    // The truncated text should be shorter than the original
    expect(summaryText.length).toBeLessThan(longSummary.length);
    // Should end at a word boundary — last char should be a letter/punctuation, not a space
    expect(summaryText).not.toMatch(/\s$/);
    // The truncation point should correspond to a space in the original text
    // (i.e. the character after our truncated text in the original should be a space)
    const truncLen = summaryText.length;
    expect(longSummary[truncLen] === " " || longSummary[truncLen] === undefined).toBe(true);
  });

  it("handles summaries with no spaces in first 150 chars (edge case)", () => {
    const noSpaces = "a".repeat(200); // 200-char string with no spaces
    const result = getContextualGreeting({ source: "location", locationName: "Harare", weatherSummary: noSpaces })!;
    expect(result).toContain("...");
    // Should fall back to hard slice at 150, not slice(0, -1)
    expect(result).toContain("a".repeat(150));
  });

  it("returns greeting for source=history", () => {
    const result = getContextualGreeting({ source: "history", locationName: "Bulawayo", historyDays: 14 });
    expect(result).toContain("**Bulawayo**");
    expect(result).toContain("14-day");
  });

  it("defaults to 30 days for history when historyDays not provided", () => {
    const result = getContextualGreeting({ source: "history", locationName: "Bulawayo" });
    expect(result).toContain("30-day");
  });

  it("returns greeting for source=explore", () => {
    const result = getContextualGreeting({ source: "explore", exploreQuery: "farming areas" });
    expect(result).toContain('"farming areas"');
  });

  it("returns null for unrecognized source", () => {
    const result = getContextualGreeting({ source: "unknown" });
    expect(result).toBeNull();
  });

  it("returns null for location source without locationName", () => {
    const result = getContextualGreeting({ source: "location" });
    expect(result).toBeNull();
  });

  it("returns null for explore source without exploreQuery", () => {
    const result = getContextualGreeting({ source: "explore" });
    expect(result).toBeNull();
  });
});

describe("getContextualPrompts behavioral tests", () => {
  it("returns 3 location-specific prompts for source=location", () => {
    const prompts = getContextualPrompts({ source: "location", locationName: "Harare" });
    expect(prompts).toHaveLength(3);
    expect(prompts[0].label).toContain("Harare");
    expect(prompts[0].query).toContain("Harare");
  });

  it("uses 'this location' when locationName is absent", () => {
    const prompts = getContextualPrompts({ source: "location" });
    expect(prompts[0].label).toContain("this location");
  });

  it("returns 3 history-specific prompts for source=history", () => {
    const prompts = getContextualPrompts({ source: "history", locationName: "Mutare", historyDays: 7 });
    expect(prompts).toHaveLength(3);
    expect(prompts[0].query).toContain("7 days");
    expect(prompts[1].query).toContain("Mutare");
  });

  it("defaults to 30 days in history prompts", () => {
    const prompts = getContextualPrompts({ source: "history", locationName: "Mutare" });
    expect(prompts[0].query).toContain("30 days");
  });

  it("returns 3 explore-specific prompts for source=explore", () => {
    const prompts = getContextualPrompts({ source: "explore", exploreQuery: "low frost" });
    expect(prompts).toHaveLength(3);
    expect(prompts[0].query).toContain('"low frost"');
  });

  it("handles explore without exploreQuery", () => {
    const prompts = getContextualPrompts({ source: "explore" });
    expect(prompts[0].query).toContain("similar weather");
  });

  it("returns empty array for unrecognized source", () => {
    const prompts = getContextualPrompts({ source: "unknown" });
    expect(prompts).toHaveLength(0);
  });
});

describe("scroll-to-bottom button", () => {
  it("tracks showScrollBtn state", () => {
    expect(source).toContain("showScrollBtn");
    expect(source).toContain("setShowScrollBtn");
  });

  it("monitors scroll position on the ScrollArea viewport via viewportRef", () => {
    expect(source).toContain("viewportRef");
    expect(source).toContain("scrollHeight");
    expect(source).toContain("distanceFromBottom");
  });

  it("uses viewportRef instead of querying Radix internal attributes", () => {
    // viewportRef is forwarded through ScrollArea to the Radix Viewport element
    expect(source).toContain("viewportRef={viewportRef}");
    // No internal Radix attribute queries
    expect(source).not.toContain("data-radix-scroll-area-viewport");
  });

  it("shows button when scrolled more than 100px from bottom", () => {
    expect(source).toContain("distanceFromBottom > 100");
  });

  it("renders scroll-to-bottom button with aria-label", () => {
    expect(source).toContain('aria-label="Scroll to bottom"');
  });

  it("calls scrollToBottom on click", () => {
    expect(source).toContain("onClick={scrollToBottom}");
    expect(source).toContain("scrollIntoView");
  });

  it("uses ArrowDownIcon", () => {
    expect(source).toContain("ArrowDownIcon");
  });

  it("meets 44px minimum touch target", () => {
    // h-11 w-11 = 44px
    expect(source).toContain("h-11 w-11");
  });

  it("auto-scroll respects user scroll position — only scrolls when near bottom", () => {
    // The auto-scroll effect should check distanceFromBottom before scrolling,
    // so users reading previous context aren't yanked to the bottom
    expect(source).toContain("distanceFromBottom < 100");
  });

  it("auto-scroll defers measurement with rAF for accurate scrollHeight", () => {
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("cancelAnimationFrame");
  });

  it("uses fixRadixTableLayout prop to scope ScrollArea override", () => {
    // The [&>div]:!block fix should be opt-in via fixRadixTableLayout, not global
    expect(source).toContain("fixRadixTableLayout");
  });
});
