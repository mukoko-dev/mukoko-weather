"use client";

import { useState, useRef, useEffect, useCallback, Component, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { SparklesIcon, MapPinIcon } from "@/lib/weather-icons";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { getScrollBehavior } from "@/lib/utils";
import {
  generateSuggestedPrompts,
  fetchSuggestedRules,
  type SuggestedPrompt,
} from "@/lib/suggested-prompts";
import type { WeatherData } from "@/lib/weather";
import type { ZimbabweLocation } from "@/lib/locations";

// ---------------------------------------------------------------------------
// Inline error boundary for ReactMarkdown
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
  timestamp: Date;
}

interface Props {
  weather: WeatherData;
  location: ZimbabweLocation;
  initialSummary: string | null;
  season?: string;
}

/** Max follow-up messages before redirecting to Shamwari */
const MAX_FOLLOWUP_MESSAGES = 5;

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function ArrowUpIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 7-7 7 7" /><path d="M12 19V5" />
    </svg>
  );
}

function ChevronDownIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function ChevronUpIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Markdown link sanitisation
// ---------------------------------------------------------------------------

function isSafeHref(href: string | undefined): boolean {
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
  a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a"> & { href?: string }) => {
    if (!isSafeHref(href)) {
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
// Component
// ---------------------------------------------------------------------------

export function AISummaryChat({ weather, location, initialSummary, season }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestedPrompts, setSuggestedPrompts] = useState<SuggestedPrompt[]>([]);
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const setShamwariContext = useAppStore((s) => s.setShamwariContext);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Count user messages to enforce max
  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const atMessageLimit = userMessageCount >= MAX_FOLLOWUP_MESSAGES;

  // Fetch suggested prompts from database on mount
  useEffect(() => {
    fetchSuggestedRules().then((rules) => {
      const prompts = generateSuggestedPrompts(weather, location, selectedActivities, rules);
      setSuggestedPrompts(prompts);
    });
  }, [weather, location, selectedActivities]);


  // Scroll to bottom when messages change
  useEffect(() => {
    if (expanded && messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: getScrollBehavior() });
    }
  }, [messages, expanded]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading || atMessageLimit) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Build history (text-only, capped)
      const history = messages.slice(-MAX_FOLLOWUP_MESSAGES * 2).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 2000),
      }));

      const res = await fetch("/api/py/ai/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: trimmed,
          locationName: location.name,
          locationSlug: location.slug,
          weatherSummary: initialSummary || "",
          activities: selectedActivities.length > 0 ? selectedActivities : [],
          season: season || "",
          history,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: data.response || "I wasn't able to generate a response.",
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: "assistant",
        content: "Sorry, I couldn't process that. The weather data above is still available.",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [loading, atMessageLimit, messages, location, initialSummary, selectedActivities, season]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleContinueInShamwari = () => {
    setShamwariContext({
      source: "location",
      locationSlug: location.slug,
      locationName: location.name,
      province: location.province,
      weatherSummary: initialSummary || undefined,
      temperature: weather.current.temperature_2m,
      condition: String(weather.current.weather_code),
      activities: selectedActivities,
      timestamp: Date.now(),
    });
  };

  if (!initialSummary) return null;

  return (
    <section aria-label="AI weather follow-up chat">
      <div className="rounded-[var(--radius-card)] border-l-4 border-tanzanite bg-surface-card shadow-sm">
        {/* Expand/collapse toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-between px-4 py-3 text-left sm:px-6 min-h-[44px]"
          aria-expanded={expanded}
          type="button"
        >
          <div className="flex items-center gap-2">
            <SparklesIcon size={16} className="text-tanzanite" />
            <span className="text-base font-medium text-text-primary">
              Ask a follow-up question
            </span>
          </div>
          {expanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
        </button>

        {expanded && (
          <div className="border-t border-border px-4 pb-4 sm:px-6">
            {/* Suggested prompts (shown when no messages yet) */}
            {messages.length === 0 && suggestedPrompts.length > 0 && (
              <div className="pb-3 pt-4">
                <p className="mb-2 text-base font-medium uppercase tracking-wider text-text-tertiary">
                  Suggested questions
                </p>
                <div className="flex flex-wrap gap-2">
                  {suggestedPrompts.map((prompt) => (
                    <button
                      key={prompt.label}
                      onClick={() => sendMessage(prompt.query)}
                      className="rounded-[var(--radius-badge)] border border-border bg-surface-base px-3 py-2 text-base text-text-secondary transition-colors hover:bg-surface-card hover:text-text-primary hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-primary min-h-[44px]"
                      type="button"
                      disabled={loading}
                    >
                      {prompt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Messages */}
            {messages.length > 0 && (
              <div className="space-y-3 pt-3" aria-live="polite">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`rounded-lg px-3 py-2.5 text-base ${
                      msg.role === "user"
                        ? "ml-8 bg-primary/10 text-text-primary"
                        : "mr-8 bg-surface-base text-text-secondary"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <MarkdownErrorBoundary fallback={msg.content}>
                        <div className="prose prose-base max-w-none text-text-secondary prose-strong:text-text-primary prose-headings:text-text-primary prose-li:marker:text-text-tertiary">
                          <ReactMarkdown components={markdownComponents}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                      </MarkdownErrorBoundary>
                    ) : (
                      msg.content
                    )}
                  </div>
                ))}

                {/* Loading indicator */}
                {loading && (
                  <div className="mr-8 rounded-lg bg-surface-base px-3 py-2" role="status">
                    <div className="flex items-center gap-1">
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary [animation-delay:-0.3s]" />
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary [animation-delay:-0.15s]" />
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary" />
                    </div>
                    <span className="sr-only">Thinking...</span>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}

            {/* Message limit reached — redirect to Shamwari */}
            {atMessageLimit && (
              <div className="mt-3 rounded-lg border border-tanzanite/20 bg-tanzanite/5 p-3 text-center">
                <p className="text-base text-text-secondary">
                  For a deeper conversation, continue in Shamwari chat.
                </p>
                <Link
                  href="/shamwari"
                  onClick={handleContinueInShamwari}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-[var(--radius-badge)] bg-tanzanite px-4 py-2 text-base font-medium text-mineral-tanzanite-fg transition-colors hover:bg-tanzanite/90 min-h-[44px]"
                >
                  <SparklesIcon size={14} />
                  Continue in Shamwari
                </Link>
              </div>
            )}

            {/* Chat input — card style */}
            {!atMessageLimit && (
              <form onSubmit={handleSubmit} className="mt-3">
                <div className="rounded-2xl border border-border bg-surface-base shadow-sm">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      // Auto-grow: capped at 96px (max-h-24) so inline style.height
                      // doesn't override the Tailwind max-height constraint.
                      e.target.style.height = "auto";
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 96)}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage(input);
                      }
                    }}
                    placeholder="Ask about this weather..."
                    className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base text-text-primary placeholder:text-text-tertiary outline-none disabled:cursor-not-allowed disabled:opacity-50 max-h-24 overflow-y-auto"
                    rows={1}
                    disabled={loading}
                    aria-label="Follow-up question"
                  />
                  <div className="flex items-center justify-end px-3 pb-2.5">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={loading || !input.trim()}
                      className="h-11 w-11 rounded-full p-0 shrink-0"
                      aria-label="Send follow-up question"
                    >
                      <ArrowUpIcon size={16} />
                    </Button>
                  </div>
                </div>
              </form>
            )}

            {/* Link to Shamwari (always visible when there are messages) */}
            {messages.length > 0 && !atMessageLimit && (
              <div className="mt-2 text-center">
                <Link
                  href="/shamwari"
                  onClick={handleContinueInShamwari}
                  className="inline-flex items-center gap-1 text-base text-text-tertiary transition-colors hover:text-tanzanite"
                >
                  <MapPinIcon size={10} />
                  Continue in Shamwari for a deeper conversation
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
