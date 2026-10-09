"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { ArrowDown } from "lucide-react";
import { SparklesIcon, MapPinIcon } from "@/lib/weather-icons";
import { ChatComposer } from "@/components/ui/chat-composer";
import { SafeMarkdown } from "@/components/ui/safe-markdown";
import { TypingDots } from "@/components/ui/typing-dots";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useAppStore,
  isShamwariContextValid,
  type ShamwariContext,
} from "@/lib/store";
import { getScrollBehavior } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";
import {
  fetchSuggestedRules,
  getExplorePrompts,
  type SuggestedPrompt,
} from "@/lib/suggested-prompts";

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
// Suggested prompts
// ---------------------------------------------------------------------------

/** Cap rendered messages to prevent unbounded memory growth in long conversations. */
const MAX_RENDERED_MESSAGES = 30;

/**
 * Hardcoded safety net for when the database-driven prompt rules are
 * unavailable. The live defaults come from the AI prompt library
 * (`ai_suggested_rules` with surface:"explore") via getExplorePrompts() —
 * same DB-first-with-fallback pattern as AISummaryChat.
 */
const FALLBACK_SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  { label: "Drone flying today", query: "Can I fly a drone today?" },
  {
    label: "Farming advice",
    query: "What's the best time to plant crops this season?",
  },
  {
    label: "Safari weather",
    query: "What's the weather like for safari this weekend?",
  },
  { label: "Compare cities", query: "Compare weather in Nairobi and Bangkok" },
  { label: "Road trip", query: "Is it safe for a road trip today?" },
  {
    label: "Weekend plans",
    query: "What outdoor activities can I do this weekend?",
  },
];

/**
 * Generate contextual suggested prompts based on Shamwari context.
 * These replace the default prompts when the user arrives with context.
 */
function getContextualPrompts(
  ctx: ShamwariContext,
): { label: string; query: string }[] {
  const loc = ctx.locationName || "this location";

  if (ctx.source === "location") {
    return [
      {
        label: `More about ${loc}`,
        query: `Tell me more about the weather in ${loc}`,
      },
      {
        label: "Activity advice",
        query: `What activities are best for today's weather in ${loc}?`,
      },
      {
        label: "Compare locations",
        query: `Compare ${loc} weather with nearby cities`,
      },
    ];
  }

  if (ctx.source === "history") {
    return [
      {
        label: "Explain trends",
        query: `What do the weather trends in ${loc} over the last ${ctx.historyDays || 30} days tell us?`,
      },
      {
        label: "Farming impact",
        query: `How have recent weather patterns affected farming in ${loc}?`,
      },
      {
        label: "Future outlook",
        query: `Based on recent history, what should I expect next in ${loc}?`,
      },
    ];
  }

  if (ctx.source === "explore") {
    return [
      {
        label: "Refine search",
        query: ctx.exploreQuery
          ? `Show me more locations like "${ctx.exploreQuery}"`
          : `What other locations have similar weather?`,
      },
      {
        label: "Detailed comparison",
        query: `Compare the weather conditions of locations you found`,
      },
      {
        label: "Best option",
        query: `Which location is best for outdoor activities right now?`,
      },
    ];
  }

  return FALLBACK_SUGGESTED_PROMPTS;
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
    const tempInfo =
      ctx.temperature != null ? ` at ${Math.round(ctx.temperature)}°C` : "";
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

export function ExploreChatbot() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [contextualPrompts, setContextualPrompts] = useState<
    { label: string; query: string }[] | null
  >(null);
  // Database-driven default prompts (surface:"explore" rules from the AI
  // prompt library); the hardcoded set is only the unavailable-DB fallback.
  const [defaultPrompts, setDefaultPrompts] = useState<SuggestedPrompt[]>(
    FALLBACK_SUGGESTED_PROMPTS,
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Send user's selected activities so the AI can personalise advice
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
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Load the database-driven default prompts (5-min client cache inside
  // fetchSuggestedRules). Keep the hardcoded fallback when the DB has no
  // explore-surface rules or the API is unavailable.
  useEffect(() => {
    let alive = true;
    fetchSuggestedRules()
      .then((rules) => {
        const fromDb = getExplorePrompts(rules);
        if (alive && fromDb.length > 0) setDefaultPrompts(fromDb);
      })
      .catch(() => {
        // API unavailable — the hardcoded fallback stays in place.
      });
    return () => {
      alive = false;
    };
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
        messagesEndRef.current?.scrollIntoView({
          behavior: getScrollBehavior(),
        });
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
      const distanceFromBottom =
        vp.scrollHeight - vp.scrollTop - vp.clientHeight;
      setShowScrollBtn(distanceFromBottom > 100);
    };
    vp.addEventListener("scroll", handleScroll, { passive: true });
    return () => vp.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: getScrollBehavior() });
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date(),
      };

      setMessages((prev) =>
        [...prev, userMessage].slice(-MAX_RENDERED_MESSAGES),
      );
      setInput("");
      // Reset textarea height back to single row after sending
      setLoading(true);
      trackEvent("ai_chat_sent", { source: "shamwari" });

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
            ...(selectedActivities.length > 0 && {
              activities: selectedActivities,
            }),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Surface actionable messages (e.g. rate-limit "Too many requests")
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.response ?? body?.error ?? `Request failed (${res.status})`,
          );
        }

        const data: ExploreResponse = await res.json();

        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: data.response,
          references: data.references,
          timestamp: new Date(),
        };

        setMessages((prev) =>
          [...prev, assistantMessage].slice(-MAX_RENDERED_MESSAGES),
        );
      } catch (err) {
        // Silently ignore aborted requests (user navigated away or sent a new message)
        if (err instanceof DOMException && err.name === "AbortError") return;
        const fallback =
          "I'm having trouble connecting right now. Please try again in a moment.";
        const errorMessage: ChatMessage = {
          id: `error-${Date.now()}`,
          role: "assistant",
          content:
            err instanceof Error && err.message !== "Failed to fetch"
              ? err.message
              : fallback,
          timestamp: new Date(),
        };
        setMessages((prev) =>
          [...prev, errorMessage].slice(-MAX_RENDERED_MESSAGES),
        );
      } finally {
        setLoading(false);
        // Refocus input after response
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [loading, messages, selectedActivities],
  );

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
        <ScrollArea
          viewportRef={viewportRef}
          className="h-full"
          fixRadixTableLayout
        >
          <div
            className="px-4 py-5 space-y-6 overflow-x-hidden"
            aria-live="polite"
            aria-relevant="additions"
          >
            {messages.length === 0 && (
              <EmptyState
                prompts={defaultPrompts}
                onSuggestionClick={handleSuggestion}
                loading={loading}
              />
            )}
            {messages.length > 0 &&
              contextualPrompts &&
              contextualPrompts.length > 0 &&
              messages.length === 1 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {contextualPrompts.map((prompt) => (
                    <button
                      key={prompt.query}
                      onClick={() => handleSuggestion(prompt.query)}
                      className="quail flex items-center text-left"
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
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Input area — shared composer */}
      <div className="shrink-0 px-3 pb-3 pt-2">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSend={() => sendMessage(input)}
          disabled={loading}
          maxHeight={160}
          placeholder="Ask about weather, locations, activities..."
          ariaLabel="Ask Shamwari Explorer"
          surface="card"
          textareaRef={inputRef}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state with suggested prompts
// ---------------------------------------------------------------------------

function EmptyState({
  prompts,
  onSuggestionClick,
  loading,
}: {
  prompts: SuggestedPrompt[];
  onSuggestionClick: (query: string) => void;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="hoopoe-xl">
        <SparklesIcon size={24} className="text-primary" />
      </div>
      <h2 className="giraffe text-lg mt-4">Shamwari Explorer</h2>
      <p className="mt-2 max-w-sm text-center text-base text-text-secondary">
        Ask me anything about weather, locations, and activities. I can help you
        plan your day, compare conditions, and get activity-specific advice.
      </p>

      <div className="mt-6 w-full max-w-md">
        <p className="hornbill font-medium mb-3">Try asking</p>
        <div className="grid grid-cols-2 gap-2">
          {prompts.map((prompt) => (
            <button
              key={prompt.query}
              onClick={() => onSuggestionClick(prompt.query)}
              className="quail flex items-center text-left disabled:cursor-not-allowed disabled:opacity-50"
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
          <p className="text-base break-words leading-relaxed">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  // Assistant messages: full-width, no bubble — like Claude's chat UI
  return (
    <div className="min-w-0">
      <div className="flex items-start gap-2.5">
        <div className="hoopoe mt-0.5">
          <SparklesIcon size={14} className="text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <SafeMarkdown
            content={message.content}
            className="break-words overflow-hidden prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-pre:overflow-x-auto prose-pre:max-w-full prose-code:break-words"
          />

          {/* Location references as quick links */}
          {message.references && message.references.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5 pt-2">
              {message.references
                .filter(
                  (ref) => ref.type === "location" || ref.type === "weather",
                )
                .slice(0, 5)
                .map((ref) => (
                  <Link
                    key={ref.slug}
                    href={`/${ref.slug}`}
                    className="flamingo-link"
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
    <div className="flex items-start gap-2.5">
      <div className="hoopoe mt-0.5">
        <SparklesIcon size={14} className="text-primary" />
      </div>
      <TypingDots label="Shamwari Explorer is thinking..." />
    </div>
  );
}
