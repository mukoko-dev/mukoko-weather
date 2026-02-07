import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";
import { LOCATIONS, getLocationBySlug, getZimbabweSeason } from "../data/locations";

const TIER_1_SLUGS = new Set([
  "harare", "bulawayo", "mutare", "gweru", "masvingo",
  "kwekwe", "kadoma", "marondera", "chinhoyi", "victoria-falls",
]);
const TIER_2_TAGS = new Set(["farming", "mining", "education", "border"]);
const TTL_TIER_1 = 1800;
const TTL_TIER_2 = 3600;
const TTL_TIER_3 = 7200;

function getTtl(slug: string, tags: string[]): number {
  if (TIER_1_SLUGS.has(slug)) return TTL_TIER_1;
  if (tags.some((t) => TIER_2_TAGS.has(t))) return TTL_TIER_2;
  return TTL_TIER_3;
}

interface CachedSummary {
  insight: string;
  generatedAt: string;
  temperature: number;
  weatherCode: number;
}

const SYSTEM_PROMPT = `You are Shamwari Weather, the AI assistant for mukoko weather — Zimbabwe's weather intelligence platform. You provide actionable, contextual weather advice grounded in Zimbabwean geography, agriculture, industry, and culture.

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

export const aiRoutes = new Hono<{ Bindings: Env }>();

aiRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const { weatherData, location } = body;

  if (!weatherData || !location) {
    return c.json({ error: "Missing weather data or location" }, 400);
  }

  const currentTemp = weatherData.current?.temperature_2m ?? 0;
  const currentCode = weatherData.current?.weather_code ?? 0;
  const locationSlug = (location.name as string ?? "unknown").toLowerCase().replace(/\s+/g, "-");

  const knownLocation = getLocationBySlug(locationSlug);
  const locationTags = knownLocation?.tags ?? [];
  const ttl = getTtl(locationSlug, locationTags);

  // Check KV cache
  const cacheKey = `ai-summary:${locationSlug}`;
  const cachedRaw = await c.env.AI_SUMMARIES.get(cacheKey);
  if (cachedRaw) {
    try {
      const cached: CachedSummary = JSON.parse(cachedRaw);
      const tempDelta = Math.abs(cached.temperature - currentTemp);
      const codeChanged = cached.weatherCode !== currentCode;
      if (tempDelta <= 5 && !codeChanged) {
        return c.json({ insight: cached.insight, cached: true, generatedAt: cached.generatedAt });
      }
    } catch {
      // Corrupted cache entry, regenerate
    }
  }

  const season = getZimbabweSeason();
  const apiKey = c.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    const temp = weatherData.current?.temperature_2m;
    const humidity = weatherData.current?.relative_humidity_2m;
    const insight = `Current conditions in ${location.name}: ${temp !== undefined ? Math.round(temp) + "°C" : "N/A"} with ${humidity !== undefined ? humidity + "%" : "N/A"} humidity. We are in the ${season.shona} season (${season.name}). ${season.description}. Stay informed and plan your day accordingly.`;

    await c.env.AI_SUMMARIES.put(cacheKey, JSON.stringify({
      insight, generatedAt: new Date().toISOString(), temperature: currentTemp, weatherCode: currentCode,
    }), { expirationTtl: ttl });

    return c.json({ insight, cached: false });
  }

  const anthropic = new Anthropic({ apiKey });
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Generate a weather briefing for ${location.name}, Zimbabwe (elevation: ${location.elevation}m).
${locationTags.length > 0 ? `This area is relevant to: ${locationTags.join(", ")}.` : ""}

Current conditions: ${JSON.stringify(weatherData.current)}
3-day forecast summary: max temps ${JSON.stringify(weatherData.daily?.temperature_2m_max)}, min temps ${JSON.stringify(weatherData.daily?.temperature_2m_min)}, weather codes ${JSON.stringify(weatherData.daily?.weather_code)}
Season: ${season.shona} (${season.name})

Provide:
1. A 2-sentence general summary
2. One industry/context-specific tip relevant to this area`,
    }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  const insight = textBlock?.text ?? "No insight available.";

  await c.env.AI_SUMMARIES.put(cacheKey, JSON.stringify({
    insight, generatedAt: new Date().toISOString(), temperature: currentTemp, weatherCode: currentCode,
  }), { expirationTtl: ttl });

  return c.json({ insight, cached: false, generatedAt: new Date().toISOString() });
});
