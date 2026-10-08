"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { SparklesIcon } from "@/lib/weather-icons";
import { ChatComposer } from "@/components/ui/chat-composer";
import { SafeMarkdown } from "@/components/ui/safe-markdown";
import { TypingDots } from "@/components/ui/typing-dots";
import { useAppStore } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { ShamwariCTA } from "./ShamwariCTA";
import { getScrollBehavior } from "@/lib/utils";
import {
  generateSuggestedPrompts,
  fetchSuggestedRules,
  type SuggestedPrompt,
} from "@/lib/suggested-prompts";
import type { WeatherData } from "@/lib/weather";
import type { WeatherLocation } from "@/lib/locations";
import { trackEvent } from "@/lib/analytics";
import type { AISummaryUser } from "./AISummary";
import { ShamwariSignInCTA } from "./ShamwariSignInCTA";

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
  location: WeatherLocation;
  initialSummary: string | null;
  season?: string;
  /**
   * Signed-in user, or `null` when anonymous. Anonymous visitors see a
   * sign-in CTA instead of the follow-up chat (the `/api/ai/*` proxy is
   * gated server-side and would 401 every send anyway).
   */
  user: AISummaryUser | null;
}

/** Max follow-up messages before redirecting to Shamwari */
const MAX_FOLLOWUP_MESSAGES = 5;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AISummaryChat({
  weather,
  location,
  initialSummary,
  season,
  user,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestedPrompts, setSuggestedPrompts] = useState<SuggestedPrompt[]>(
    [],
  );
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const shamwariEnabled = isFeatureEnabled("shamwari_chat");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Count user messages to enforce max
  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const atMessageLimit = userMessageCount >= MAX_FOLLOWUP_MESSAGES;

  // Fetch suggested prompts from database on mount
  useEffect(() => {
    fetchSuggestedRules().then((rules) => {
      const prompts = generateSuggestedPrompts(
        weather,
        location,
        selectedActivities,
        rules,
      );
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
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
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
      trackEvent("ai_chat_sent", { source: "inline", location: location.slug });

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // Build history (text-only, capped)
        const history = messages.slice(-MAX_FOLLOWUP_MESSAGES * 2).map((m) => ({
          role: m.role,
          content: m.content.slice(0, 2000),
        }));

        const res = await fetch("/api/ai/followup", {
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
          content:
            "Sorry, I couldn't process that. The weather data above is still available.",
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setLoading(false);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [
      loading,
      atMessageLimit,
      messages,
      location,
      initialSummary,
      selectedActivities,
      season,
    ],
  );

  const shamwariContext = {
    source: "location" as const,
    locationSlug: location.slug,
    locationName: location.name,
    province: location.province,
    weatherSummary: initialSummary || undefined,
    temperature: weather.current.temperature_2m,
    condition: String(weather.current.weather_code),
    activities: selectedActivities,
  };

  if (!initialSummary) return null;
  if (!user)
    return (
      <ShamwariSignInCTA
        title="Ask Shamwari about this weather"
        body={`Sign in to chat with Mukoko's AI about ${location.name}.`}
        accent="tanzanite"
      />
    );

  return (
    <section aria-label="AI weather follow-up chat">
      <div className="rounded-[var(--radius-card)] border-l-4 border-tanzanite bg-surface-card shadow-sm">
        {/* Expand/collapse toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-between px-4 py-3 text-left sm:px-6 min-h-[var(--touch-target-min)]"
          aria-expanded={expanded}
          type="button"
        >
          <div className="flex items-center gap-2">
            <SparklesIcon size={16} className="text-tanzanite" />
            <span className="text-base font-medium text-text-primary">
              Ask a follow-up question
            </span>
          </div>
          {expanded ? (
            <ChevronUp size={16} aria-hidden="true" />
          ) : (
            <ChevronDown size={16} aria-hidden="true" />
          )}
        </button>

        {expanded && (
          <div className="border-t border-border px-4 pb-4 sm:px-6">
            {/* Suggested prompts (shown when no messages yet) */}
            {messages.length === 0 && suggestedPrompts.length > 0 && (
              <div className="pb-3 pt-4">
                <p className="hornbill font-medium mb-2">Suggested questions</p>
                <div className="flex flex-wrap gap-2">
                  {suggestedPrompts.map((prompt) => (
                    <button
                      key={prompt.label}
                      onClick={() => sendMessage(prompt.query)}
                      className="quail"
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
                    className={`rounded-[var(--radius-input)] px-3 py-2.5 text-base ${
                      msg.role === "user"
                        ? "ml-8 bg-primary/10 text-text-primary"
                        : "mr-8 bg-surface-base text-text-secondary"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <SafeMarkdown content={msg.content} />
                    ) : (
                      msg.content
                    )}
                  </div>
                ))}

                {/* Loading indicator */}
                {loading && (
                  <div className="mr-8 rounded-[var(--radius-input)] bg-surface-base px-3">
                    <TypingDots size="sm" label="Thinking..." />
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}

            {/* Message limit reached — redirect to Shamwari when it's a
                reachable destination; otherwise just say the limit was hit,
                no dead link to a paused page. */}
            {atMessageLimit && (
              <div className="mt-3 rounded-[var(--radius-input)] border border-tanzanite/20 bg-tanzanite/5 p-3 text-center">
                {shamwariEnabled ? (
                  <>
                    <p className="gazelle">
                      For a deeper conversation, continue in Shamwari chat.
                    </p>
                    <ShamwariCTA
                      context={shamwariContext}
                      label="Continue in Shamwari"
                      variant="tanzanite"
                      className="mt-2"
                    />
                  </>
                ) : (
                  <p className="gazelle">
                    You&apos;ve reached the follow-up limit for this
                    conversation.
                  </p>
                )}
              </div>
            )}

            {/* Chat input — shared composer */}
            {!atMessageLimit && (
              <ChatComposer
                className="mt-3"
                value={input}
                onChange={setInput}
                onSend={() => sendMessage(input)}
                disabled={loading}
                maxHeight={96}
                placeholder="Ask about this weather..."
                ariaLabel="Follow-up question"
                sendLabel="Send follow-up question"
                textareaRef={inputRef}
              />
            )}

            {/* Link to Shamwari (always visible when there are messages) */}
            {messages.length > 0 && !atMessageLimit && (
              <div className="mt-2 text-center">
                <ShamwariCTA
                  context={shamwariContext}
                  label="Continue in Shamwari for a deeper conversation"
                  variant="text"
                  icon="map-pin"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
