import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { logError, logWarn } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
import { anthropicBreaker, CircuitOpenError } from "@/lib/circuit-breaker";
import { evaluateRule } from "@/lib/suitability";
import {
  getLocationsForContext,
  getLocationFromDb,
  searchLocationsFromDb,
  getAllActivitiesFromDb,
  getCachedWeather,
  getWeatherForLocation,
  getSeasonForDate,
  getLocationsByTagFromDb,
  getAllSuitabilityRules,
  type LocationDoc,
} from "@/lib/db";

// ---------------------------------------------------------------------------
// Module-level singleton Anthropic client (reuses HTTP connection pool across
// warm Vercel function invocations instead of creating a new client per request)
// ---------------------------------------------------------------------------

let _anthropicClient: Anthropic | null = null;
let _anthropicClientKey: string | null = null;

function getAnthropicClient(apiKey: string): Anthropic {
  if (!_anthropicClient || _anthropicClientKey !== apiKey) {
    _anthropicClient = new Anthropic({ apiKey });
    _anthropicClientKey = apiKey;
  }
  return _anthropicClient;
}

// ---------------------------------------------------------------------------
// Tool execution timeout — prevents a hanging MongoDB query from blocking
// the entire serverless function until Vercel's 60s limit.
// ---------------------------------------------------------------------------

const TOOL_TIMEOUT_MS = 15_000; // 15 seconds per tool execution

function withToolTimeout<T>(promise: Promise<T>, toolName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS}ms`)),
      TOOL_TIMEOUT_MS,
    );
    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/** Maximum allowed message length (characters). */
const MAX_MESSAGE_LENGTH = 2000;

/** Slug format guard — prevents pathological strings from reaching DB queries. */
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/** Known location tags — returned to Claude when an invalid tag is provided. */
const KNOWN_TAGS = ["city", "farming", "mining", "tourism", "education", "border", "travel", "national-park"];

/** Weather result type returned by executeGetWeather. */
type WeatherResult = Awaited<ReturnType<typeof executeGetWeather>>;

/** Shared model ID for Claude Haiku. */
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Module-level caches (persist across warm function invocations)
// ---------------------------------------------------------------------------

/** Shared TTL for module-level caches (locations + activities). */
const MODULE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let cachedLocationContext: string | null = null;
let cachedLocationContextAt = 0;

async function getLocationContext(): Promise<string> {
  if (cachedLocationContext && Date.now() - cachedLocationContextAt < MODULE_CACHE_TTL) {
    return cachedLocationContext;
  }
  const sampleLocations = await getLocationsForContext(50);
  const locationNames = sampleLocations.map(
    (l: LocationDoc) => `${l.name} (/${l.slug}) — ${l.province}, ${(l.country ?? "ZW").toUpperCase()}`
  );
  cachedLocationContext = `\n\nAvailable locations (sample of ${sampleLocations.length}):\n${locationNames.join("\n")}`;
  cachedLocationContextAt = Date.now();
  return cachedLocationContext;
}

interface ActivityRecord { id: string; label: string; category: string; description: string }
let cachedActivities: ActivityRecord[] | null = null;
let cachedActivitiesAt = 0;

async function getCachedActivities(): Promise<ActivityRecord[]> {
  if (cachedActivities && Date.now() - cachedActivitiesAt < MODULE_CACHE_TTL) {
    return cachedActivities;
  }
  const all = await getAllActivitiesFromDb();
  cachedActivities = all.map((a) => ({ id: a.id, label: a.label, category: a.category, description: a.description }));
  cachedActivitiesAt = Date.now();
  return cachedActivities;
}

// ---------------------------------------------------------------------------
// System prompt for the Explore assistant
// ---------------------------------------------------------------------------

const EXPLORE_SYSTEM_PROMPT = `You are Shamwari Explorer, the conversational AI assistant for mukoko weather — an AI-powered weather intelligence platform focused on Africa and developing regions.

Your personality:
- Warm, knowledgeable, and community-minded (Ubuntu philosophy)
- You speak with authority about weather, geography, agriculture, industry, and culture
- You are helpful, concise, and always actionable
- You prioritise safety and practical advice

You help users:
1. Discover locations and their weather conditions
2. Get activity-specific weather advice (farming, mining, travel, tourism, sports, drone flying, etc.)
3. Compare weather across locations
4. Understand seasonal patterns and forecasts
5. Plan activities based on current and forecasted weather

DATA GUARDRAILS — CRITICAL:
- ONLY use weather data returned by the tools (search_locations, get_weather, get_activity_advice, list_locations_by_tag). NEVER invent, estimate, or hallucinate weather numbers.
- All weather data comes from Tomorrow.io (primary) and Open-Meteo (fallback) APIs. Do not reference or claim data from any other weather provider.
- If a tool returns no data or an error, say so honestly — do not guess or fill in numbers.
- ONLY discuss locations that exist in our database. Use the search_locations tool to verify a location exists before providing weather info.
- Do not provide medical, legal, or financial advice. Stick to weather, activity planning, and geography.
- If asked about topics unrelated to weather, locations, or outdoor activities, politely redirect to weather-related topics.

When responding:
- Use markdown formatting: **bold** for emphasis, bullet points for lists, and clear structure
- Be concise but informative — aim for 3-6 sentences per topic
- When weather data is provided, reference specific numbers (temperatures, wind speeds, etc.)
- Always include at least one actionable recommendation
- Do not use emoji
- When mentioning a location, format it as a clickable link: [Location Name](/location-slug)
- When discussing activities, mention specific weather factors that matter (wind for drones, visibility for travel, etc.)
- If the user asks about a location you have data for, always include current conditions
- If you can't find the exact location, suggest similar ones from the available data

Available activity categories: farming, mining, travel, tourism, sports, casual`;

// ---------------------------------------------------------------------------
// Tool definitions for Claude function calling
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_locations",
    description:
      "Search for weather locations by name, province, or country. Returns matching locations with their coordinates and tags.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query — location name, province, or country",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_weather",
    description:
      "Get current weather conditions and forecast for a specific location by its slug (URL-safe name). Returns temperature, humidity, wind, precipitation, UV index, and 7-day forecast.",
    input_schema: {
      type: "object" as const,
      properties: {
        location_slug: {
          type: "string",
          description: "The URL slug of the location (e.g. 'harare', 'victoria-falls', 'bulawayo')",
        },
      },
      required: ["location_slug"],
    },
  },
  {
    name: "get_activity_advice",
    description:
      "Get weather suitability advice for specific activities at a location. Checks wind, visibility, precipitation, UV, heat stress, and thunderstorm risk relevant to the activity.",
    input_schema: {
      type: "object" as const,
      properties: {
        location_slug: {
          type: "string",
          description: "The URL slug of the location",
        },
        activities: {
          type: "array",
          items: { type: "string" },
          description: "Activity IDs to check (e.g. ['drone-flying', 'hiking', 'crop-farming'])",
        },
      },
      required: ["location_slug", "activities"],
    },
  },
  {
    name: "list_locations_by_tag",
    description:
      "List all locations matching a specific tag/category. Tags: city, farming, mining, tourism, national-park, education, border, travel.",
    input_schema: {
      type: "object" as const,
      properties: {
        tag: {
          type: "string",
          description: "The location tag to filter by",
        },
      },
      required: ["tag"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution helpers
// ---------------------------------------------------------------------------

async function executeSearchLocations(query: string) {
  const result = await searchLocationsFromDb(query);
  if (result.locations.length === 0) {
    return { found: false, message: `No locations found for "${query}"`, locations: [] };
  }
  return {
    found: true,
    count: result.total,
    locations: result.locations.slice(0, 10).map((loc) => ({
      name: loc.name,
      slug: loc.slug,
      province: loc.province,
      country: loc.country ?? "ZW",
      tags: loc.tags,
      lat: loc.lat,
      lon: loc.lon,
      elevation: loc.elevation,
    })),
  };
}

async function executeGetWeather(locationSlug: string) {
  // Try cache first, then fetch fresh
  const cached = await getCachedWeather(locationSlug);
  if (cached) {
    // Fetch location and season in parallel. Start season lookup with "ZW"
    // default (majority of locations); re-fetch only if the location is non-ZW.
    const [loc, zwSeason] = await Promise.all([
      getLocationFromDb(locationSlug),
      getSeasonForDate(new Date(), "ZW"),
    ]);
    const country = loc?.country ?? "ZW";
    const season = country === "ZW" ? zwSeason : await getSeasonForDate(new Date(), country);
    return {
      found: true,
      locationSlug,
      locationName: loc?.name ?? locationSlug,
      current: {
        temperature: cached.current.temperature_2m,
        feelsLike: cached.current.apparent_temperature,
        humidity: cached.current.relative_humidity_2m,
        windSpeed: cached.current.wind_speed_10m,
        windGusts: cached.current.wind_gusts_10m,
        windDirection: cached.current.wind_direction_10m,
        precipitation: cached.current.precipitation,
        cloudCover: cached.current.cloud_cover,
        uvIndex: cached.current.uv_index,
        pressure: cached.current.surface_pressure,
      },
      daily: {
        dates: cached.daily.time.slice(0, 5),
        maxTemps: cached.daily.temperature_2m_max.slice(0, 5),
        minTemps: cached.daily.temperature_2m_min.slice(0, 5),
        precipitationSum: cached.daily.precipitation_sum.slice(0, 5),
        precipitationProbability: cached.daily.precipitation_probability_max.slice(0, 5),
        maxWindSpeed: cached.daily.wind_speed_10m_max.slice(0, 5),
        uvIndexMax: cached.daily.uv_index_max.slice(0, 5),
      },
      insights: cached.insights ?? null,
      season: { name: season.name, shona: season.shona, description: season.description },
    };
  }

  // Try fetching fresh weather data
  try {
    const location = await getLocationFromDb(locationSlug);
    if (!location) {
      return { found: false, message: `Location "${locationSlug}" not found` };
    }
    const weatherResult = await getWeatherForLocation(
      location.slug,
      location.lat,
      location.lon,
      location.elevation,
    );
    const weather = weatherResult.data;
    const country = location.country ?? "ZW";
    const season = await getSeasonForDate(new Date(), country);
    return {
      found: true,
      locationSlug: location.slug,
      locationName: location.name,
      current: {
        temperature: weather.current.temperature_2m,
        feelsLike: weather.current.apparent_temperature,
        humidity: weather.current.relative_humidity_2m,
        windSpeed: weather.current.wind_speed_10m,
        windGusts: weather.current.wind_gusts_10m,
        windDirection: weather.current.wind_direction_10m,
        precipitation: weather.current.precipitation,
        cloudCover: weather.current.cloud_cover,
        uvIndex: weather.current.uv_index,
        pressure: weather.current.surface_pressure,
      },
      daily: {
        dates: weather.daily.time.slice(0, 5),
        maxTemps: weather.daily.temperature_2m_max.slice(0, 5),
        minTemps: weather.daily.temperature_2m_min.slice(0, 5),
        precipitationSum: weather.daily.precipitation_sum.slice(0, 5),
        precipitationProbability: weather.daily.precipitation_probability_max.slice(0, 5),
        maxWindSpeed: weather.daily.wind_speed_10m_max.slice(0, 5),
        uvIndexMax: weather.daily.uv_index_max.slice(0, 5),
      },
      insights: weather.insights ?? null,
      season: { name: season.name, shona: season.shona, description: season.description },
    };
  } catch (err) {
    logWarn({
      source: "weather-api",
      location: locationSlug,
      message: `Weather fetch failed in explore tool for "${locationSlug}"`,
      error: err,
    });
    return { found: false, message: `Unable to fetch weather for "${locationSlug}"` };
  }
}

/** In-request suitability rules cache — avoids redundant MongoDB queries
 *  when Claude calls get_activity_advice multiple times in one tool-use loop. */
type RulesCache = { rules: Awaited<ReturnType<typeof getAllSuitabilityRules>> | null };

async function executeGetActivityAdvice(locationSlug: string, activityIds: string[], weatherCache?: Map<string, WeatherResult>, rulesCache?: RulesCache) {
  // Reuse cached weather from the same request to avoid double-fetching
  // when Claude calls get_weather then get_activity_advice for the same location.
  let weatherResult: WeatherResult;
  const cached = weatherCache?.get(locationSlug);
  if (cached) {
    weatherResult = cached;
  } else {
    weatherResult = await executeGetWeather(locationSlug);
    weatherCache?.set(locationSlug, weatherResult);
  }
  if (!weatherResult.found) {
    return weatherResult;
  }

  const allActivities = await getCachedActivities();
  const matchedActivities = activityIds
    .map((id) => allActivities.find((a) => a.id === id))
    .filter((a) => a != null);

  if (matchedActivities.length === 0) {
    const validIds = allActivities.slice(0, 20).map((a) => a.id);
    return {
      found: true,
      locationSlug,
      error: `No matching activities found for IDs: ${activityIds.join(", ")}. Valid IDs include: ${validIds.join(", ")}`,
    };
  }

  const insights = "insights" in weatherResult ? weatherResult.insights : null;

  // Run suitability evaluation server-side so the LLM receives structured
  // ratings (level, label, detail) instead of raw insights. This reduces
  // hallucination surface and makes AI responses more consistent.
  // Batch-fetch all rules once per request (cached via rulesCache ref).
  const suitability: Record<string, { level: string; label: string; detail: string; metric?: string }> = {};
  if (insights) {
    try {
      if (rulesCache && !rulesCache.rules) {
        rulesCache.rules = await getAllSuitabilityRules();
      }
      // rulesCache is always provided by the tool-use loop, so rulesCache.rules
      // is populated above. The ?? fallback guards hypothetical standalone callers.
      const allRules = rulesCache?.rules ?? await getAllSuitabilityRules();
      const ruleMap = new Map(allRules.map((r) => [r.key, r]));
      for (const activity of matchedActivities) {
        const rule = ruleMap.get(`activity:${activity.id}`) ?? ruleMap.get(`category:${activity.category}`);
        if (rule) {
          const rating = evaluateRule(rule, insights);
          suitability[activity.id] = {
            level: rating.level,
            label: rating.label,
            detail: rating.detail,
            metric: rating.metric,
          };
        }
      }
    } catch (suitErr) {
      logWarn({
        source: "mongodb",
        message: "Suitability evaluation failed — skipping server-side ratings",
        location: locationSlug,
        error: suitErr,
      });
    }
  }

  return {
    found: true,
    locationSlug,
    weather: weatherResult,
    activities: matchedActivities,
    insights,
    suitability: Object.keys(suitability).length > 0 ? suitability : undefined,
  };
}

const TAG_RESULTS_CAP = 20;

async function executeListLocationsByTag(tag: string) {
  const locations = await getLocationsByTagFromDb(tag);
  const capped = locations.slice(0, TAG_RESULTS_CAP);
  return {
    tag,
    count: locations.length,
    showing: capped.length,
    note: locations.length > TAG_RESULTS_CAP ? `Showing first ${TAG_RESULTS_CAP} of ${locations.length} locations` : undefined,
    locations: capped.map((loc: LocationDoc) => ({
      name: loc.name,
      slug: loc.slug,
      province: loc.province,
      country: loc.country ?? "ZW",
    })),
  };
}

// ---------------------------------------------------------------------------
// Main POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    // ── Rate limiting ────────────────────────────────────────────────────────
    // Vercel's edge layer controls x-forwarded-for — the first entry is the
    // real client IP and cannot be spoofed by end users. If infrastructure
    // changes (e.g. migration away from Vercel), revisit this trust assumption.
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (!ip) {
      return NextResponse.json(
        { error: "Unable to identify client. Please try again." },
        { status: 400 },
      );
    }
    const rateLimit = await checkRateLimit(ip, "explore", 20, 3600); // 20 requests/hour/IP
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000)) },
        },
      );
    }

    const { message, history, activities: userActivities } = await request.json();

    // ── Input validation ─────────────────────────────────────────────────────
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` },
        { status: 400 },
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        response: "The Explore assistant requires an AI configuration. Please check the setup.",
        references: [],
      });
    }

    const anthropic = getAnthropicClient(apiKey);

    // Build conversation history.
    // Trust model: the server owns the system prompt (immutable guardrails);
    // history messages are user-controlled and placed in user/assistant roles.
    // Claude's system prompt explicitly prohibits fabricating weather data,
    // which is the primary defense against prompt injection via history.
    //
    // SECURITY NOTE: A sophisticated injection payload in assistant history
    // could attempt to override the system prompt. Mitigations:
    //   1. System prompt guardrails (DATA GUARDRAILS section) are strong
    //   2. History is length-capped (MAX_MESSAGE_LENGTH) to limit payload size
    //   3. Only the last 10 history messages are included
    const messages: Anthropic.MessageParam[] = [];

    // Add prior conversation history if provided (capped at 10, length-checked).
    if (Array.isArray(history)) {
      for (const msg of history.slice(-10)) {
        if (!msg || typeof msg !== "object") continue;
        if (msg.role === "user" && typeof msg.content === "string") {
          messages.push({ role: "user", content: truncateHistoryContent(msg.content) });
        } else if (msg.role === "assistant" && typeof msg.content === "string") {
          messages.push({ role: "assistant", content: truncateHistoryContent(msg.content) });
        }
      }
    }

    // Add the current message (sanitize consistently with history messages)
    messages.push({ role: "user", content: truncateHistoryContent(message) });

    // Fetch location context and activity list (module-level 5min caches) for Claude awareness
    let locationContext = "";
    try {
      locationContext = await getLocationContext();
    } catch {
      // Continue without location context
    }

    let activityContext = "";
    try {
      const activities = await getCachedActivities();
      activityContext = `\n\nKey activities: ${activities.map((a) => a.label.toLowerCase()).join(", ")}`;
    } catch {
      // Continue without activity context
    }

    // Append user's selected activities (from Zustand store) so Claude can
    // proactively offer advice relevant to the user's interests.
    let userActivityContext = "";
    if (Array.isArray(userActivities) && userActivities.length > 0) {
      const validIds = userActivities.filter((a): a is string => typeof a === "string").slice(0, 10);
      if (validIds.length > 0) {
        userActivityContext = `\n\nThe user has selected these activities in their preferences: ${validIds.join(", ")}. Proactively include weather advice for these activities when relevant.`;
      }
    }

    // ── Claude call with circuit breaker ──────────────────────────────────────
    const systemPrompt = EXPLORE_SYSTEM_PROMPT + activityContext + userActivityContext + locationContext;
    let response = await anthropicBreaker.execute(() =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      }),
    );

    // Agentic tool-use loop — process tool calls until Claude returns a final text response
    const maxIterations = 5;
    let iterations = 0;
    const references: { slug: string; name: string; type: string }[] = [];
    // In-request caches: prevent redundant MongoDB/API round-trips when Claude
    // calls the same tool multiple times in one tool-use loop.
    const weatherCache = new Map<string, WeatherResult>();
    const rulesCache: RulesCache = { rules: null };

    while (response.stop_reason === "tool_use" && iterations < maxIterations) {
      iterations++;
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        let result: unknown;
        try {
          const input = toolUse.input as Record<string, unknown>;
          switch (toolUse.name) {
            case "search_locations": {
              const query = typeof input.query === "string" ? input.query.slice(0, 200) : "";
              if (!query) { result = { error: "Missing query parameter" }; break; }
              result = await withToolTimeout(executeSearchLocations(query), "search_locations");
              const searchResult = result as { found: boolean; locations?: { slug: string; name: string }[] };
              if (searchResult.found && searchResult.locations) {
                for (const loc of searchResult.locations) {
                  references.push({ slug: loc.slug, name: loc.name, type: "location" });
                }
              }
              break;
            }
            case "get_weather": {
              const slug = typeof input.location_slug === "string" ? input.location_slug : "";
              if (!slug) { result = { error: "Missing location_slug parameter" }; break; }
              if (!SLUG_RE.test(slug)) { result = { error: "Invalid location identifier" }; break; }
              const cachedWeather = weatherCache.get(slug);
              if (cachedWeather) {
                result = cachedWeather;
              } else {
                const freshWeather = await withToolTimeout(executeGetWeather(slug), "get_weather");
                weatherCache.set(slug, freshWeather);
                result = freshWeather;
              }
              const weatherResult = result as { found: boolean; locationSlug?: string; locationName?: string };
              if (weatherResult.found && weatherResult.locationSlug) {
                references.push({ slug: weatherResult.locationSlug, name: weatherResult.locationName ?? weatherResult.locationSlug, type: "weather" });
              }
              break;
            }
            case "get_activity_advice": {
              const slug = typeof input.location_slug === "string" ? input.location_slug : "";
              const activities = (Array.isArray(input.activities) ? input.activities.filter((a): a is string => typeof a === "string") : []).slice(0, 10);
              if (!slug) { result = { error: "Missing location_slug parameter" }; break; }
              if (!SLUG_RE.test(slug)) { result = { error: "Invalid location identifier" }; break; }
              result = await withToolTimeout(executeGetActivityAdvice(slug, activities, weatherCache, rulesCache), "get_activity_advice");
              break;
            }
            case "list_locations_by_tag": {
              const tag = typeof input.tag === "string" ? input.tag : "";
              if (!tag) { result = { error: "Missing tag parameter" }; break; }
              if (!KNOWN_TAGS.includes(tag)) { result = { error: `Unknown tag "${tag}". Valid tags: ${KNOWN_TAGS.join(", ")}` }; break; }
              result = await withToolTimeout(executeListLocationsByTag(tag), "list_locations_by_tag");
              break;
            }
            default:
              result = { error: `Unknown tool: ${toolUse.name}` };
          }
        } catch (err) {
          logWarn({
            source: "ai-api",
            location: "explore",
            message: `Tool ${toolUse.name} execution failed`,
            error: err,
          });
          result = { error: `Tool execution failed: ${err instanceof Error ? err.message : "Unknown error"}` };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      // Continue conversation with tool results
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      response = await anthropicBreaker.execute(() =>
        anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          tools: TOOLS,
          messages,
        }),
      );
    }

    // Extract the final text response
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    const responseText = textBlock?.text ?? "I wasn't able to process that request. Please try rephrasing your question.";

    return NextResponse.json({
      response: responseText,
      // Deduplicate references, preferring "location" type over "weather"
      references: deduplicateReferences(references),
    });
  } catch (err) {
    // Circuit breaker is open — Anthropic is temporarily unavailable
    if (err instanceof CircuitOpenError) {
      return NextResponse.json({
        response: "The AI assistant is temporarily unavailable due to service issues. Please try again in a few minutes.",
        references: [],
        error: true,
      });
    }

    logError({
      source: "ai-api",
      severity: "medium",
      message: "Explore assistant error",
      location: "explore",
      error: err,
    });

    return NextResponse.json({
      response: "I'm having trouble processing your request right now. Please try again in a moment.",
      references: [],
      error: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/**
 * Truncate history/message content to the max allowed length.
 *
 * This is length enforcement, not content sanitization — the Anthropic Messages
 * API handles prompt boundaries via structured turns (no regex stripping needed).
 *
 * Prompt injection defenses (all in place):
 *   1. Structured messages array — the Messages API sends each turn as a
 *      separate object with an explicit role. "\n\nHuman:" / "\n\nAssistant:"
 *      boundary markers have NO special meaning and cannot inject new turns.
 *   2. System prompt DATA GUARDRAILS constrain Claude's response scope.
 *   3. History capped at 10 messages × MAX_MESSAGE_LENGTH chars each.
 *   4. Tool output is server-controlled — Claude never sees raw API responses.
 *   5. Circuit breaker + rate limiter bound request volume.
 */
function truncateHistoryContent(content: string): string {
  return content.slice(0, MAX_MESSAGE_LENGTH);
}

/** Maximum number of reference links returned to the client. */
const MAX_REFERENCES = 20;

/** Deduplicate references by slug, preferring "location" type over "weather". */
function deduplicateReferences(refs: { slug: string; name: string; type: string }[]) {
  const map = new Map<string, { slug: string; name: string; type: string }>();
  for (const r of refs) {
    const existing = map.get(r.slug);
    // Keep "location" type if we already have it; otherwise take the new entry
    if (!existing || (existing.type !== "location" && r.type === "location")) {
      map.set(r.slug, r);
    }
  }
  return [...map.values()].slice(0, MAX_REFERENCES);
}
