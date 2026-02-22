"use client";

import { useState, useRef, useEffect, useCallback, Component, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { SparklesIcon, SearchIcon, MapPinIcon } from "@/lib/weather-icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore } from "@/lib/store";

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
      return <p className="text-sm text-text-secondary">{this.props.fallback}</p>;
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
    return url.protocol === "https:" || url.protocol === "http:";
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

const SUGGESTED_PROMPTS = [
  { label: "Drone flying in Harare", query: "Can I fly a drone in Harare today?" },
  { label: "Farming advice", query: "What's the best time to plant maize in Mashonaland?" },
  { label: "Safari weather", query: "What's the weather like for safari in Victoria Falls?" },
  { label: "Compare cities", query: "Compare weather in Harare and Bulawayo" },
  { label: "Road trip", query: "Is it safe to drive from Harare to Mutare today?" },
  { label: "Weekend plans", query: "What outdoor activities can I do this weekend in Gweru?" },
];

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

export function ExploreChatbot() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Send user's selected activities so Claude can personalise advice
  const selectedActivities = useAppStore((s) => s.selectedActivities);

  // Cancel in-flight fetch on unmount to prevent state updates on unmounted component
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

      const res = await fetch("/api/explore", {
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
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-4 space-y-4" aria-live="polite" aria-relevant="additions">
          {messages.length === 0 && (
            <EmptyState onSuggestionClick={handleSuggestion} />
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {loading && <TypingIndicator />}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="shrink-0 border-t border-border bg-surface-base/50 backdrop-blur-sm px-4 py-3">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <div className="relative flex-1">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Auto-grow: reset height then expand to scrollHeight (capped by max-h).
                // Uses inline style.height because the value is dynamically calculated
                // from scrollHeight — not expressible as a static Tailwind class.
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                // Submit on Enter (without Shift); Shift+Enter inserts a newline
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="Ask about weather, locations, activities..."
              rows={1}
              className="flex w-full resize-none rounded-[var(--radius-input)] bg-surface-base pl-9 pr-4 py-2 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 max-h-32 overflow-y-auto"
              aria-label="Ask Shamwari Explorer"
              disabled={loading}
            />
            <SearchIcon size={14} className="absolute left-3 top-3 text-text-tertiary" aria-hidden="true" />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={loading || !input.trim()}
            className="min-h-[44px] min-w-[44px] px-3 shrink-0"
            aria-label="Send message"
          >
            <ArrowUpIcon size={18} />
          </Button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state with suggested prompts
// ---------------------------------------------------------------------------

function EmptyState({ onSuggestionClick }: { onSuggestionClick: (query: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <SparklesIcon size={24} className="text-primary" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-text-primary font-heading">
        Shamwari Explorer
      </h2>
      <p className="mt-2 max-w-sm text-center text-sm text-text-secondary">
        Ask me anything about weather, locations, and activities. I can help you
        plan your day, compare conditions, and get activity-specific advice.
      </p>

      <div className="mt-6 w-full max-w-md">
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-tertiary">
          Try asking
        </p>
        <div className="grid grid-cols-2 gap-2">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button
              key={prompt.query}
              onClick={() => onSuggestionClick(prompt.query)}
              className="flex items-center rounded-[var(--radius-card)] border border-border bg-surface-card px-3 py-3 text-left text-sm text-text-secondary transition-colors hover:bg-surface-base hover:text-text-primary hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-primary min-h-[44px]"
              type="button"
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

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-[var(--radius-card)] px-4 py-3 ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-surface-card shadow-sm"
        }`}
      >
        {isUser ? (
          <p className="text-sm">{message.content}</p>
        ) : (
          <MarkdownErrorBoundary fallback={message.content}>
            <div className="prose prose-sm max-w-none text-text-secondary prose-strong:text-text-primary prose-headings:text-text-primary prose-li:marker:text-text-tertiary prose-a:text-primary prose-a:no-underline hover:prose-a:underline">
              <ReactMarkdown components={markdownComponents}>{message.content}</ReactMarkdown>
            </div>
          </MarkdownErrorBoundary>
        )}

        {/* Location references as quick links */}
        {!isUser && message.references && message.references.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/50 pt-2.5">
            {message.references
              .filter((ref) => ref.type === "location" || ref.type === "weather")
              .slice(0, 5)
              .map((ref) => (
                <Link
                  key={ref.slug}
                  href={`/${ref.slug}`}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-badge)] bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                >
                  <MapPinIcon size={10} className="shrink-0" />
                  {ref.name}
                </Link>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex justify-start" role="status">
      <div className="flex gap-1.5 rounded-[var(--radius-card)] bg-surface-card px-4 py-3 shadow-sm">
        <span className="h-2 w-2 animate-bounce rounded-full bg-text-tertiary [animation-delay:0ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-text-tertiary [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-text-tertiary [animation-delay:300ms]" />
      </div>
      {/* Inside role="status" so screen readers announce it */}
      <span className="sr-only">Shamwari Explorer is thinking...</span>
    </div>
  );
}
