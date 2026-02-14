import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getZimbabweSeason } from "@/lib/weather";
import { logError } from "@/lib/observability";
import {
  getCachedAISummary,
  setCachedAISummary,
  isSummaryStale,
} from "@/lib/db";
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
- Use markdown formatting: **bold** for emphasis, bullet points for lists
- Keep responses concise (3-4 sentences for the summary)
- Always include at least one actionable recommendation
- Do not use emoji
- Do not use headings (no # or ##) — the section already has a heading`;

export async function POST(request: Request) {
  try {
    const { weatherData, location, activities } = await request.json();
    const userActivities: string[] = Array.isArray(activities) ? activities : [];
    if (!weatherData || !location) {
      return NextResponse.json({ error: "Missing weather data or location" }, { status: 400 });
    }

    const currentTemp = weatherData.current?.temperature_2m ?? 0;
    const currentCode = weatherData.current?.weather_code ?? 0;
    const locationSlug = (location.name as string ?? "unknown").toLowerCase().replace(/\s+/g, "-");
    // Look up the location in our database to get tags for tiered TTL
    const knownLocation = getLocationBySlug(locationSlug);
    const locationTags = knownLocation?.tags ?? [];

    // Check MongoDB cache first — serves all concurrent users from a single cached entry
    const cached = await getCachedAISummary(locationSlug);
    if (cached && !isSummaryStale(cached, currentTemp, currentCode)) {
      return NextResponse.json({
        insight: cached.insight,
        cached: true,
        generatedAt: cached.generatedAt.toISOString(),
      });
    }
    // Cache miss or stale — generate fresh AI summary
    const season = getZimbabweSeason();
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // Fallback to a basic summary when no API key is configured
      const temp = weatherData.current?.temperature_2m;
      const humidity = weatherData.current?.relative_humidity_2m;
      const insight = `Current conditions in ${location.name}: ${temp !== undefined ? Math.round(temp) + "\u00B0C" : "N/A"} with ${humidity !== undefined ? humidity + "%" : "N/A"} humidity. We are in the ${season.shona} season (${season.name}). ${season.description}. Stay informed and plan your day accordingly.`;

      await setCachedAISummary(
        locationSlug,
        insight,
        { temperature: currentTemp, weatherCode: currentCode },
        locationTags,
      );

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
${userActivities.length > 0 ? `The user's activities: ${userActivities.join(", ")}. Tailor advice to these activities.` : ""}

Current conditions: ${JSON.stringify(weatherData.current)}
3-day forecast summary: max temps ${JSON.stringify(weatherData.daily?.temperature_2m_max)}, min temps ${JSON.stringify(weatherData.daily?.temperature_2m_min)}, weather codes ${JSON.stringify(weatherData.daily?.weather_code)}
Season: ${season.shona} (${season.name})

Provide:
1. A 2-sentence general summary
2. ${userActivities.length > 0 ? `One specific tip for the user's activities (${userActivities.slice(0, 3).join(", ")})` : "One industry/context-specific tip relevant to this area (e.g. farming advice for farming areas, safety for mining areas, travel conditions for border/travel areas, outdoor guidance for tourism/national parks)"}`,
        },
      ],
    });
    const textBlock = message.content.find((b) => b.type === "text");
    const insight = textBlock?.text ?? "No insight available.";

    // Store in MongoDB cache — all subsequent requests for this location get the cached version
    await setCachedAISummary(
      locationSlug,
      insight,
      { temperature: currentTemp, weatherCode: currentCode },
      locationTags,
    );

    return NextResponse.json({ insight, cached: false, generatedAt: new Date().toISOString() });
  } catch (err) {
    const errorLocation = typeof location === "object" && location !== null
      ? String((location as unknown as Record<string, unknown>).name ?? "unknown")
      : undefined;
    logError({
      source: "ai-api",
      severity: "medium",
      location: errorLocation,
      message: "AI service unavailable",
      error: err,
    });
    return NextResponse.json({ error: "AI service unavailable" }, { status: 502 });
  }
}
