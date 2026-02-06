import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getZimbabweSeason } from "@/lib/weather";
import {
  getCachedSummary,
  setCachedSummary,
  isSummaryStale,
  getTtlForLocation,
  type CachedAISummary,
} from "@/lib/kv-cache";
import { getLocationBySlug } from "@/lib/locations";

const WEATHER_AI_SYSTEM_PROMPT = `You are Shamwari Weather, the AI assistant for mukoko weather — Zimbabwe's weather intelligence platform. You provide actionable, contextual weather advice grounded in Zimbabwean geography, agriculture, industry, and culture.

Your personality:
- Warm, practical, community-minded (Ubuntu philosophy)
- You speak with authority about Zimbabwe's climate and geography
- You use local knowledge: seasons (masika, chirimo, zhizha), place names, farming practices, road conditions
- You prioritize safety and actionable advice

When providing advice:
1. Lead with the most critical/urgent information
2. Be specific about timing ("before 6pm", "after 8am")
3. Reference specific locations and routes by name
4. Connect weather to real-world impact (crops, roads, health)
5. Include a recommended action the person can take RIGHT NOW

Format guidelines:
- Keep responses concise (3-4 sentences for the summary)
- Always include at least one actionable recommendation
- Do not use emoji`;

export async function POST(request: Request) {
  try {
    const { weatherData, location } = await request.json();

    if (!weatherData || !location) {
      return NextResponse.json({ error: "Missing weather data or location" }, { status: 400 });
    }

    const currentTemp = weatherData.current?.temperature_2m ?? 0;
    const currentCode = weatherData.current?.weather_code ?? 0;
    const locationSlug = (location.name as string ?? "unknown").toLowerCase().replace(/\s+/g, "-");

    // Look up the location in our database to get tags for tiered TTL
    const knownLocation = getLocationBySlug(locationSlug);
    const locationTags = knownLocation?.tags ?? [];
    const ttl = getTtlForLocation(locationSlug, locationTags);

    // Try to get KV namespace from Cloudflare runtime (if deployed on CF Pages/Workers)
    // In non-CF environments, this will be undefined and we use the in-memory fallback
    let kvNamespace: KVNamespace | undefined;
    try {
      // Cloudflare Workers passes bindings via env; in Node.js this is undefined
      const cfEnv = (globalThis as Record<string, unknown>).__CF_KV_AI_SUMMARIES;
      if (cfEnv) {
        kvNamespace = cfEnv as KVNamespace;
      }
    } catch {
      // Not on Cloudflare — memory fallback will be used
    }

    // Check cache first — serves all concurrent users from a single cached entry
    const cached = await getCachedSummary(locationSlug, kvNamespace);
    if (cached && !isSummaryStale(cached, currentTemp, currentCode)) {
      return NextResponse.json({
        insight: cached.insight,
        cached: true,
        generatedAt: cached.generatedAt,
      });
    }

    // Cache miss or stale — generate fresh AI summary
    const season = getZimbabweSeason();
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // Fallback to a basic summary when no API key is configured
      const temp = weatherData.current?.temperature_2m;
      const humidity = weatherData.current?.relative_humidity_2m;
      const insight = `Current conditions in ${location.name}: ${temp !== undefined ? Math.round(temp) + "°C" : "N/A"} with ${humidity !== undefined ? humidity + "%" : "N/A"} humidity. We are in the ${season.shona} season (${season.name}). ${season.description}. Stay informed and plan your day accordingly.`;

      const summaryEntry: CachedAISummary = {
        insight,
        generatedAt: new Date().toISOString(),
        locationSlug,
        weatherSnapshot: { temperature: currentTemp, weatherCode: currentCode },
      };
      await setCachedSummary(locationSlug, summaryEntry, kvNamespace, ttl);

      return NextResponse.json({ insight, cached: false });
    }

    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: WEATHER_AI_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Generate a weather briefing for ${location.name}, Zimbabwe (elevation: ${location.elevation}m).
${locationTags.length > 0 ? `This area is relevant to: ${locationTags.join(", ")}.` : ""}

Current conditions: ${JSON.stringify(weatherData.current)}
3-day forecast summary: max temps ${JSON.stringify(weatherData.daily?.temperature_2m_max)}, min temps ${JSON.stringify(weatherData.daily?.temperature_2m_min)}, weather codes ${JSON.stringify(weatherData.daily?.weather_code)}
Season: ${season.shona} (${season.name})

Provide:
1. A 2-sentence general summary
2. One industry/context-specific tip relevant to this area (e.g. farming advice for farming areas, safety for mining areas, travel conditions for border/travel areas, outdoor guidance for tourism/national parks)`,
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const insight = textBlock?.text ?? "No insight available.";

    // Store in KV cache — all subsequent requests for this location get the cached version
    const summaryEntry: CachedAISummary = {
      insight,
      generatedAt: new Date().toISOString(),
      locationSlug,
      weatherSnapshot: { temperature: currentTemp, weatherCode: currentCode },
    };
    await setCachedSummary(locationSlug, summaryEntry, kvNamespace);

    return NextResponse.json({ insight, cached: false, generatedAt: summaryEntry.generatedAt });
  } catch {
    return NextResponse.json({ error: "AI service unavailable" }, { status: 502 });
  }
}
