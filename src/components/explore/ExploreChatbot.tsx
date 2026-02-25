"use client";

import { useState, useRef, useEffect, useCallback, Component, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { SparklesIcon, MapPinIcon } from "@/lib/weather-icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore, isShamwariContextValid, type ShamwariContext } from "@/lib/store";
import { getScrollBehavior } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Inline error boundary for ReactMarkdown — prevents malformed markdown from
// crashing the entire chat UI. Aligns with per-section error isolation pattern.
// ---------------------------------------------------------------------------

interface MarkdownErrorBoundaryState { hasError: boolean }

class MarkdownErrorBoundary extends Component<{ children: ReactNode; fallback: string }, MarkdownErrorBoundaryState> {
  state: MarkdownErrorBoundaryState = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return <p className="text-base text-text-secondary">{this.props.fallback}</p>;
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  references?: { slug: string; name: string; type: string }[];
  timestamp: Date;
}

interface ExploreResponse {
  response: string;
  references: { slug: string; name: string; type: string }[];
  error?: boolean;
}

// ---------------------------------------------------------------------------
// Markdown link sanitisation — only allow safe hrefs (relative or https://)
// ---------------------------------------------------------------------------

/** Allow relative paths and https:// URLs only; block javascript:, data:, etc. */
function isSafeHref(href: string | undefined): boolean {
  if (!href) return false;
  if (href.startsWith("/") || href.startsWith("#")) return true;
  try {
    const url = new URL(href);
    // Only allow https: — http: could enable link injection to plaintext targets.
    // Relative paths and fragment anchors are handled above.
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

const markdownComponents = {
  a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a"> & { href?: string }) => {
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
// Suggested prompts
// ---------------------------------------------------------------------------

/** Cap rendered messages to prevent unbounded memory growth in long conversations. */
const MAX_RENDERED_MESSAGES = 30;

const DEFAULT_SUGGESTED_PROMPTS = [
  { label: "Drone flying in Harare", query: "Can I fly a drone in Harare today?" },
  { label: "Farming advice", query: "What's the best time to plant maize in Mashonaland?" },
  { label: "Safari weather", query: "What's the weather like for safari in Victoria Falls?" },
  { label: "Compare cities", query: "Compare weather in Harare and Bulawayo" },
  { label: "Road trip", query: "Is it safe to drive from Harare to Mutare today?" },
  { label: "Weekend plans", query: "What outdoor activities can I do this weekend in Gweru?" },
];

/**
 * Generate contextual suggested prompts based on Shamwari context.
 * These replace the default prompts when the user arrives with context.
 */
function getContextualPrompts(ctx: ShamwariContext): { label: string; query: string }[] {
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

  return DEFAULT_SUGGESTED_PROMPTS;
}

/**
 * Generate a contextual greeting message based on Shamwari context.
 * Returns null if no context or if context type is not recognized.
 *
 * Note: Greeting templates are also seeded in seed-ai-prompts.ts
 * (greeting:location_context, etc.) for future DB-driven rendering.
 * These hardcoded greetings serve as the primary source until
 * the greeting logic is migrated to fetch from the API.
 */
function getContextualGreeting(ctx: ShamwariContext): string | null {
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ArrowUpIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 7-7 7 7" /><path d="M12 19V5" />
    </svg>
  );
}

function ArrowDownIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m19 12-7 7-7-7" /><path d="M12 5v14" />
    </svg>
  );
}

export function ExploreChatbot() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [contextualPrompts, setContextualPrompts] = useState<{ label: string; query: string }[] | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Send user's selected activities so Claude can personalise advice
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const shamwariContext = useAppStore((s) => s.shamwariContext);
  const clearShamwariContext = useAppStore((s) => s.clearShamwariContext);

  // Capture context at mount time to avoid stale closure issues
  const initialContextRef = useRef(shamwariContext);

  // Consume ShamwariContext on mount: generate contextual greeting + prompts
  useEffect(() => {
    const ctx = initialContextRef.current;
    if (!isShamwariContextValid(ctx)) return;

    const greeting = getContextualGreeting(ctx);
    if (greeting) {
      const greetingMessage: ChatMessage = {
        id: `context-${Date.now()}`,
        role: "assistant",
        content: greeting,
        timestamp: new Date(),
      };
      setMessages([greetingMessage]);
    }

    // Set context-aware suggested prompts
    setContextualPrompts(getContextualPrompts(ctx));

    // Clear context after consuming (one-time use)
    clearShamwariContext();
  }, [clearShamwariContext]);

  // Cancel in-flight fetch on unmount to prevent state updates on unmounted component
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Auto-scroll to bottom when new messages arrive — but only if the user is
  // already near the bottom. If they scrolled up to re-read context, don't
  // yank them back down; the scroll-to-bottom button handles that instead.
  // Uses rAF to defer measurement until after the browser has reflowed with
  // the new message content, so scrollHeight includes the new message.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const vp = viewportRef.current;
      const distanceFromBottom = vp
        ? vp.scrollHeight - vp.scrollTop - vp.clientHeight
        : 0;
      if (distanceFromBottom < 100) {
        messagesEndRef.current?.scrollIntoView({ behavior: getScrollBehavior() });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  // Track scroll position to show/hide scroll-to-bottom button.
  // Uses viewportRef forwarded through ScrollArea to the Radix Viewport element.
  // Empty deps [] is correct: viewportRef is a stable useRef object whose identity
  // never changes. If the entire component remounts (e.g. Suspense boundary reset),
  // React creates a new component instance and all effects re-run anyway.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const handleScroll = () => {
      const distanceFromBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight;
      setShowScrollBtn(distanceFromBottom > 100);
    };
    vp.addEventListener("scroll", handleScroll, { passive: true });
    return () => vp.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: getScrollBehavior() });
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage].slice(-MAX_RENDERED_MESSAGES));
    setInput("");
    // Reset textarea height back to single row after sending
    if (inputRef.current) inputRef.current.style.height = "auto";
    setLoading(true);

    try {
      // Build history from previous messages (text only).
      // NOTE: `messages` here is the pre-update snapshot (before userMessage
      // is appended via setMessages above), which is correct — the new user
      // message is sent separately as `message` in the request body.
      // Slice to last 10 to match server cap and reduce payload size.
      const history = messages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Cancel any previous in-flight request before starting a new one
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch("/api/py/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history,
          ...(selectedActivities.length > 0 && { activities: selectedActivities }),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Surface actionable messages (e.g. rate-limit "Too many requests")
        const body = await res.json().catch(() => null);
        throw new Error(body?.response ?? body?.error ?? `Request failed (${res.status})`);
      }

      const data: ExploreResponse = await res.json();

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: data.response,
        references: data.references,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage].slice(-MAX_RENDERED_MESSAGES));
    } catch (err) {
      // Silently ignore aborted requests (user navigated away or sent a new message)
      if (err instanceof DOMException && err.name === "AbortError") return;
      const fallback = "I'm having trouble connecting right now. Please try again in a moment.";
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: "assistant",
        content: err instanceof Error && err.message !== "Failed to fetch" ? err.message : fallback,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage].slice(-MAX_RENDERED_MESSAGES));
    } finally {
      setLoading(false);
      // Refocus input after response
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [loading, messages, selectedActivities]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleSuggestion = (query: string) => {
    sendMessage(query);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Messages area */}
      <div className="relative flex-1 min-h-0">
        {/* fixRadixTableLayout: override Radix's display:table on viewport wrapper —
            without it, the flex message layout breaks.
            Tested with @radix-ui/react-scroll-area@1.4.3 — verify after upgrades.
            TODO: Remove when upstream resolves this —
            https://github.com/radix-ui/primitives/issues/926 */}
        <ScrollArea viewportRef={viewportRef} className="h-full" fixRadixTableLayout>
          <div className="px-4 py-5 space-y-6 overflow-x-hidden" aria-live="polite" aria-relevant="additions">
            {messages.length === 0 && (
              <EmptyState onSuggestionClick={handleSuggestion} loading={loading} />
            )}
            {messages.length > 0 && contextualPrompts && contextualPrompts.length > 0 && messages.length === 1 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {contextualPrompts.map((prompt) => (
                  <button
                    key={prompt.query}
                    onClick={() => handleSuggestion(prompt.query)}
                    className="flex items-center rounded-[var(--radius-card)] border border-border bg-surface-card px-3 py-2 text-left text-base text-text-secondary transition-colors hover:bg-surface-base hover:text-text-primary hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-primary min-h-[44px]"
                    type="button"
                    disabled={loading}
                  >
                    {prompt.label}
                  </button>
                ))}
              </div>
            )}

            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {loading && <TypingIndicator />}

            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Scroll-to-bottom button */}
        {showScrollBtn && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center justify-center h-11 w-11 rounded-full bg-surface-card border border-border shadow-md text-text-secondary transition-colors hover:bg-surface-base hover:text-text-primary"
            aria-label="Scroll to bottom"
          >
            <ArrowDownIcon size={16} />
          </button>
        )}
      </div>

      {/* Input area — Claude-style card */}
      <div className="shrink-0 px-3 pb-3 pt-2">
        <form onSubmit={handleSubmit}>
          <div className="rounded-2xl border border-border bg-surface-card shadow-sm">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Auto-grow: reset height then expand to scrollHeight.
                // Capped at 160px so inline style.height doesn't
                // override the Tailwind max-height constraint.
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                // Submit on Enter (without Shift); Shift+Enter inserts a newline
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(input);
                }
              }}
              placeholder="Ask about weather, locations, activities..."
              rows={1}
              className="block w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base text-text-primary placeholder:text-text-tertiary outline-none disabled:cursor-not-allowed disabled:opacity-50 max-h-40 overflow-y-auto break-words"
              aria-label="Ask Shamwari Explorer"
              disabled={loading}
            />
            <div className="flex items-center justify-end px-3 pb-3">
              <Button
                type="submit"
                size="sm"
                disabled={loading || !input.trim()}
                className="h-11 w-11 rounded-full p-0 shrink-0"
                aria-label="Send message"
              >
                <ArrowUpIcon size={18} />
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state with suggested prompts
// ---------------------------------------------------------------------------

function EmptyState({ onSuggestionClick, loading }: { onSuggestionClick: (query: string) => void; loading?: boolean }) {
  const prompts = DEFAULT_SUGGESTED_PROMPTS;

  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <SparklesIcon size={24} className="text-primary" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-text-primary font-heading">
        Shamwari Explorer
      </h2>
      <p className="mt-2 max-w-sm text-center text-base text-text-secondary">
        Ask me anything about weather, locations, and activities. I can help you
        plan your day, compare conditions, and get activity-specific advice.
      </p>

      <div className="mt-6 w-full max-w-md">
        <p className="mb-3 text-base font-medium uppercase tracking-wider text-text-tertiary">
          Try asking
        </p>
        <div className="grid grid-cols-2 gap-2">
          {prompts.map((prompt) => (
            <button
              key={prompt.query}
              onClick={() => onSuggestionClick(prompt.query)}
              className="flex items-center rounded-[var(--radius-card)] border border-border bg-surface-card px-3 py-3 text-left text-base text-text-secondary transition-colors hover:bg-surface-base hover:text-text-primary hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-primary min-h-[44px] disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={loading}
            >
              {prompt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end min-w-0">
        <div className="max-w-[85%] min-w-0 rounded-[var(--radius-card)] px-4 py-3.5 bg-primary text-primary-foreground">
          <p className="text-base break-words leading-relaxed">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant messages: full-width, no bubble — like Claude's chat UI
  return (
    <div className="min-w-0">
      <div className="flex items-start gap-2.5">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 mt-0.5">
          <SparklesIcon size={14} className="text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <MarkdownErrorBoundary fallback={message.content}>
            <div className="prose prose-base max-w-none break-words overflow-hidden text-text-secondary prose-strong:text-text-primary prose-headings:text-text-primary prose-li:marker:text-text-tertiary prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-pre:overflow-x-auto prose-pre:max-w-full prose-code:break-words">
              <ReactMarkdown components={markdownComponents}>{message.content}</ReactMarkdown>
            </div>
          </MarkdownErrorBoundary>

          {/* Location references as quick links */}
          {message.references && message.references.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5 pt-2">
              {message.references
                .filter((ref) => ref.type === "location" || ref.type === "weather")
                .slice(0, 5)
                .map((ref) => (
                  <Link
                    key={ref.slug}
                    href={`/${ref.slug}`}
                    className="inline-flex items-center gap-1 rounded-[var(--radius-badge)] bg-primary/10 px-2.5 py-1 text-base font-medium text-primary transition-colors hover:bg-primary/20"
                  >
                    <MapPinIcon size={10} className="shrink-0" />
                    {ref.name}
                  </Link>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex items-start gap-2.5" role="status">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 mt-0.5">
        <SparklesIcon size={14} className="text-primary" />
      </div>
      <div className="flex gap-1.5 py-2">
        <span className="h-2 w-2 animate-bounce rounded-full bg-text-tertiary [animation-delay:0ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-text-tertiary [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-text-tertiary [animation-delay:300ms]" />
      </div>
      {/* Inside role="status" so screen readers announce it */}
      <span className="sr-only">Shamwari Explorer is thinking...</span>
    </div>
  );
}
