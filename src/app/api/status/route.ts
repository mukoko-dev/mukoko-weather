import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getApiKey } from "@/lib/db";

interface CheckResult {
  name: string;
  status: "operational" | "degraded" | "down";
  latencyMs: number;
  message: string;
}

async function checkMongoDB(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const db = getDb();
    await db.command({ ping: 1 });
    return {
      name: "MongoDB Atlas",
      status: "operational",
      latencyMs: Date.now() - start,
      message: "Connected and responding",
    };
  } catch (err) {
    return {
      name: "MongoDB Atlas",
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Connection failed",
    };
  }
}

async function checkTomorrowIo(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const apiKey = await getApiKey("tomorrow").catch(() => null);
    if (!apiKey) {
      return {
        name: "Tomorrow.io API",
        status: "degraded",
        latencyMs: Date.now() - start,
        message: "API key not configured — using Open-Meteo fallback",
      };
    }

    const url = `https://api.tomorrow.io/v4/weather/realtime?location=-17.83,31.05&apikey=${apiKey}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (response.status === 429) {
      return {
        name: "Tomorrow.io API",
        status: "degraded",
        latencyMs: Date.now() - start,
        message: "Rate limited (429) — falling back to Open-Meteo",
      };
    }

    if (!response.ok) {
      return {
        name: "Tomorrow.io API",
        status: "down",
        latencyMs: Date.now() - start,
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return {
      name: "Tomorrow.io API",
      status: "operational",
      latencyMs: Date.now() - start,
      message: "Responding normally",
    };
  } catch (err) {
    return {
      name: "Tomorrow.io API",
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Request failed",
    };
  }
}

async function checkOpenMeteo(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=-17.83&longitude=31.05&current=temperature_2m";
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!response.ok) {
      return {
        name: "Open-Meteo API",
        status: "down",
        latencyMs: Date.now() - start,
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json();
    if (data.current?.temperature_2m === undefined) {
      return {
        name: "Open-Meteo API",
        status: "degraded",
        latencyMs: Date.now() - start,
        message: "Response received but missing expected data",
      };
    }

    return {
      name: "Open-Meteo API",
      status: "operational",
      latencyMs: Date.now() - start,
      message: "Responding normally",
    };
  } catch (err) {
    return {
      name: "Open-Meteo API",
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Request failed",
    };
  }
}

async function checkAnthropicAI(): Promise<CheckResult> {
  const start = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return {
      name: "Anthropic AI (Shamwari)",
      status: "degraded",
      latencyMs: Date.now() - start,
      message: "API key not configured — basic summary fallback active",
    };
  }

  try {
    // Light check: validate the API key with a minimal request
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 401) {
      return {
        name: "Anthropic AI (Shamwari)",
        status: "down",
        latencyMs: Date.now() - start,
        message: "Invalid API key",
      };
    }

    if (response.status === 429) {
      return {
        name: "Anthropic AI (Shamwari)",
        status: "degraded",
        latencyMs: Date.now() - start,
        message: "Rate limited — AI summaries may be delayed",
      };
    }

    // 200 or any 2xx means the API is reachable and key is valid
    if (response.ok) {
      return {
        name: "Anthropic AI (Shamwari)",
        status: "operational",
        latencyMs: Date.now() - start,
        message: "Responding normally",
      };
    }

    return {
      name: "Anthropic AI (Shamwari)",
      status: "degraded",
      latencyMs: Date.now() - start,
      message: `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      name: "Anthropic AI (Shamwari)",
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Request failed",
    };
  }
}

async function checkWeatherCache(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const db = getDb();
    const count = await db.collection("weather_cache").countDocuments({
      expiresAt: { $gt: new Date() },
    });

    return {
      name: "Weather Cache",
      status: count > 0 ? "operational" : "degraded",
      latencyMs: Date.now() - start,
      message: count > 0
        ? `${count} active cached location${count !== 1 ? "s" : ""}`
        : "Cache is empty — next requests will fetch fresh data",
    };
  } catch (err) {
    return {
      name: "Weather Cache",
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Cache check failed",
    };
  }
}

async function checkAISummaryCache(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const db = getDb();
    const count = await db.collection("ai_summaries").countDocuments({
      expiresAt: { $gt: new Date() },
    });

    return {
      name: "AI Summary Cache",
      status: count > 0 ? "operational" : "degraded",
      latencyMs: Date.now() - start,
      message: count > 0
        ? `${count} active cached summar${count !== 1 ? "ies" : "y"}`
        : "Cache is empty — next requests will generate fresh summaries",
    };
  } catch (err) {
    return {
      name: "AI Summary Cache",
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Cache check failed",
    };
  }
}

export async function GET() {
  const startTime = Date.now();

  const checks = await Promise.all([
    checkMongoDB(),
    checkTomorrowIo(),
    checkOpenMeteo(),
    checkAnthropicAI(),
    checkWeatherCache(),
    checkAISummaryCache(),
  ]);

  const overallStatus = checks.every((c) => c.status === "operational")
    ? "operational"
    : checks.some((c) => c.status === "down")
      ? "degraded"
      : "degraded";

  return NextResponse.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    totalLatencyMs: Date.now() - startTime,
    checks,
  });
}
