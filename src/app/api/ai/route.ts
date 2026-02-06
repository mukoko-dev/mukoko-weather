import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getZimbabweSeason } from "@/lib/weather";

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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Fallback to a basic summary when no API key is configured
      const temp = weatherData.current?.temperature_2m;
      const humidity = weatherData.current?.relative_humidity_2m;
      const season = getZimbabweSeason();
      return NextResponse.json({
        insight: `Current conditions in ${location.name}: ${temp !== undefined ? Math.round(temp) + "°C" : "N/A"} with ${humidity !== undefined ? humidity + "%" : "N/A"} humidity. We are in the ${season.shona} season (${season.name}). ${season.description}. Stay informed and plan your day accordingly.`,
      });
    }

    const anthropic = new Anthropic({ apiKey });
    const season = getZimbabweSeason();

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: WEATHER_AI_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Generate a weather briefing for ${location.name}, Zimbabwe (elevation: ${location.elevation}m).

Current conditions: ${JSON.stringify(weatherData.current)}
3-day forecast summary: max temps ${JSON.stringify(weatherData.daily?.temperature_2m_max)}, min temps ${JSON.stringify(weatherData.daily?.temperature_2m_min)}, weather codes ${JSON.stringify(weatherData.daily?.weather_code)}
Season: ${season.shona} (${season.name})

Provide:
1. A 2-sentence general summary
2. One key actionable recommendation for today`,
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    return NextResponse.json({ insight: textBlock?.text ?? "No insight available." });
  } catch {
    return NextResponse.json({ error: "AI service unavailable" }, { status: 502 });
  }
}
