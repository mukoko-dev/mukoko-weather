import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const runtime = "edge";

// ─── In-Memory Rate Limiter ──────────────────────────────────────────────────
// NOTE: In-memory — per-isolate. Multiple concurrent edge instances may each
// track the same IP independently. Sufficient for abuse deterrence, not for
// exact quota enforcement.
const OG_RATE_LIMIT = 30;          // max requests per window
const OG_RATE_WINDOW_MS = 60_000;  // 1-minute window
const OG_MAX_TRACKED_IPS = 10_000; // cap to prevent unbounded growth under scraping
const ipHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  // Prevent unbounded map growth from unique-IP scraping attacks.
  // Prune expired entries first to preserve active windows for legitimate users,
  // then fall back to full clear only if pruning wasn't sufficient.
  if (ipHits.size > OG_MAX_TRACKED_IPS) {
    const cutoff = Date.now() - OG_RATE_WINDOW_MS;
    for (const [k, v] of ipHits) {
      if (v.every((t) => t <= cutoff)) ipHits.delete(k);
    }
    if (ipHits.size > OG_MAX_TRACKED_IPS) ipHits.clear();
  }

  const now = Date.now();
  const windowStart = now - OG_RATE_WINDOW_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > windowStart);
  if (hits.length >= OG_RATE_LIMIT) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return false;
}

// ─── Brand Tokens ────────────────────────────────────────────────────────────
// NOTE: next/og (Satori) does not support CSS custom properties — inline hex
// values are required here. Keep in sync with globals.css brand tokens:
//   tanzanite  → --color-tanzanite (#4B0082)
//   cobalt     → --color-primary   (#0047AB)
//   malachite  → --color-secondary (#004D40)
//   gold       → --color-warmth    (base: #5D4037, gold accent: #F9A825)
//   terracotta → --color-earth     (base: #8B4513, OG accent: #D4634A)
// If globals.css brand tokens change, update these values too.
const brand = {
  tanzanite: "#4B0082",
  cobalt: "#0047AB",
  malachite: "#004D40",
  gold: "#F9A825",
  terracotta: "#D4634A",
};

// ─── Templates ────────────────────────────────────────────────────────────────
const TEMPLATES = {
  home: {
    emoji: "🌤️",
    badge: "Weather Intelligence",
    gradient: `linear-gradient(135deg, ${brand.tanzanite} 0%, #2D0057 60%, #1A0033 100%)`,
  },
  location: {
    emoji: "📍",
    badge: "Live Forecast",
    gradient: `linear-gradient(135deg, ${brand.cobalt} 0%, #002A6E 60%, #001A45 100%)`,
  },
  explore: {
    emoji: "🧭",
    badge: "Explore Locations",
    gradient: `linear-gradient(135deg, #4A148C 0%, #2D0057 60%, ${brand.tanzanite} 100%)`,
  },
  history: {
    emoji: "📊",
    badge: "Weather History",
    gradient: `linear-gradient(135deg, #1A237E 0%, #0D1B6E 60%, #080F4A 100%)`,
  },
  season: {
    emoji: "🌾",
    badge: "Seasonal Outlook",
    gradient: `linear-gradient(135deg, ${brand.malachite} 0%, #003330 60%, #001F1C 100%)`,
  },
  shamwari: {
    emoji: "🤝",
    badge: "Shamwari Weather",
    gradient: `linear-gradient(135deg, ${brand.cobalt} 0%, #2D1B69 60%, #1A0033 100%)`,
  },
} as const;

type TemplateKey = keyof typeof TEMPLATES;

// ─── OG Image Component ───────────────────────────────────────────────────────
function OGImage({
  title,
  subtitle,
  location,
  province,
  temperature,
  condition,
  season,
  template,
}: {
  title: string;
  subtitle?: string;
  location?: string;
  province?: string;
  temperature?: string;
  condition?: string;
  season?: string;
  template: TemplateKey;
}) {
  const tmpl = TEMPLATES[template];

  return (
    <div
      style={{
        width: 1200,
        height: 630,
        // Solid fallback ensures a visible dark background if Satori fails to
        // render the linear-gradient. The gradient is layered on top via `background`.
        backgroundColor: "#1A0033",
        background: tmpl.gradient,
        display: "flex",
        flexDirection: "column",
        // NOTE: Georgia is not bundled in Vercel Edge runtime — Satori will
        // silently fall back to its built-in sans-serif. The serif specification
        // is kept as a progressive enhancement for environments where it's
        // available; sans-serif rendering is acceptable for all templates.
        fontFamily: "Georgia, serif",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Decorative geometry */}
      <div
        style={{
          position: "absolute",
          top: -200,
          right: -140,
          width: 560,
          height: 560,
          borderRadius: "50%",
          background: "rgba(249,168,37,0.06)",
          border: "1px solid rgba(249,168,37,0.10)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 80,
          right: 80,
          width: 260,
          height: 260,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      />
      {/* Mineral accent stripe — matches the app's MineralsStripe component */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 5,
          background: `linear-gradient(90deg, ${brand.tanzanite} 0%, ${brand.tanzanite} 20%, ${brand.cobalt} 20%, ${brand.cobalt} 40%, ${brand.malachite} 40%, ${brand.malachite} 60%, ${brand.gold} 60%, ${brand.gold} 80%, ${brand.terracotta} 80%, ${brand.terracotta} 100%)`,
          opacity: 0.65,
        }}
      />
      {/* Content */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          padding: "52px 72px",
          position: "relative",
          zIndex: 10,
        }}
      >
        {/* Top row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* Brand lockup */}
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "rgba(249,168,37,0.15)",
                border: "1px solid rgba(249,168,37,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
              }}
            >
              🌤️
            </div>
            <div>
              <div
                style={{
                  color: "#FFFFFF",
                  fontSize: 15,
                  fontWeight: 700,
                  letterSpacing: "0.02em",
                  fontFamily: "sans-serif",
                }}
              >
                mukoko weather
              </div>
              <div
                style={{
                  color: "rgba(255,255,255,0.45)",
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase" as const,
                  fontFamily: "sans-serif",
                }}
              >
                weather.mukoko.com
              </div>
            </div>
          </div>

          {/* Template badge */}
          <div
            style={{
              background: "rgba(249,168,37,0.12)",
              border: "1px solid rgba(249,168,37,0.35)",
              borderRadius: 9999,
              padding: "8px 20px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 16 }}>{tmpl.emoji}</span>
            <span
              style={{
                color: brand.gold,
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "0.04em",
                fontFamily: "sans-serif",
              }}
            >
              {tmpl.badge}
            </span>
          </div>
        </div>

        {/* Main content */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            paddingRight: 220,
          }}
        >
          {/* Season pill — wrapped in a flex row so the pill self-sizes to
              content. Satori primarily supports display flex and block; inline
              flex variants may not render correctly. Text must be light (white)
              for readability on all dark template backgrounds — brand.malachite
              (#004D40) is a surface color, unreadable as text on dark gradients. */}
          {season && (
            <div style={{ display: "flex", flexDirection: "row", marginBottom: 20 }}>
              <div
                style={{
                  display: "flex",
                  background: "rgba(0,77,64,0.25)",
                  border: "1px solid rgba(0,150,115,0.45)",
                  borderRadius: 9999,
                  padding: "5px 16px",
                }}
              >
                <span
                  style={{
                    color: "rgba(255,255,255,0.90)",
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase" as const,
                    fontFamily: "sans-serif",
                  }}
                >
                  {season}
                </span>
              </div>
            </div>
          )}

          {/* Title */}
          <div
            style={{
              color: "#FFFFFF",
              fontSize: title.length > 50 ? 42 : title.length > 30 ? 50 : 60,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: "-0.02em",
              marginBottom: subtitle ? 16 : 24,
            }}
          >
            {title}
          </div>

          {/* Subtitle */}
          {subtitle && (
            <div
              style={{
                color: "rgba(255,255,255,0.65)",
                fontSize: 20,
                lineHeight: 1.5,
                marginBottom: 24,
                fontFamily: "sans-serif",
              }}
            >
              {subtitle}
            </div>
          )}

          {/* Meta row */}
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            {temperature && (
              <div
                style={{
                  background: "rgba(249,168,37,0.12)",
                  border: "1px solid rgba(249,168,37,0.3)",
                  borderRadius: 10,
                  padding: "8px 20px",
                  display: "flex",
                  alignItems: "baseline",
                  gap: 4,
                }}
              >
                <span
                  style={{
                    color: brand.gold,
                    fontSize: 32,
                    fontWeight: 700,
                    fontFamily: "sans-serif",
                  }}
                >
                  {temperature}
                </span>
                <span
                  style={{
                    color: "rgba(249,168,37,0.7)",
                    fontSize: 16,
                    fontFamily: "sans-serif",
                  }}
                >
                  °C
                </span>
              </div>
            )}
            {condition && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    color: "rgba(255,255,255,0.55)",
                    fontSize: 16,
                    fontFamily: "sans-serif",
                  }}
                >
                  {condition}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Bottom row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 24,
            borderTop: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {location && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16 }}>📍</span>
                <span
                  style={{
                    color: "rgba(255,255,255,0.65)",
                    fontSize: 15,
                    fontFamily: "sans-serif",
                  }}
                >
                  {location}
                  {province ? `, ${province}` : ""}
                </span>
              </div>
            )}
          </div>
          <div
            style={{
              color: "rgba(255,255,255,0.28)",
              fontSize: 12,
              fontStyle: "italic",
              letterSpacing: "0.02em",
            }}
          >
            {/* Unicode curly quotes — Satori renders to canvas, not DOM,
                so HTML entities (e.g. ampersand-ldquo) would appear as literal text */}
            {"\u201CMvura yemvura inobatanidza vanhu\u201D \u00B7 Rain unites people"}
          </div>
        </div>
      </div>

      {/* Large decorative emoji — uses a fixed top offset (240px) instead of
          CSS percentage centering with partial Satori support.
          The image is 630px tall; content padding is 52px top, so vertical
          centre of the content area is ~315px. At fontSize 150, the emoji
          renders ~150px tall, so top = 315 - 75 = 240px centres it. */}
      <div
        style={{
          position: "absolute",
          right: 72,
          top: 240,
          fontSize: 150,
          opacity: 0.12,
        }}
      >
        {tmpl.emoji}
      </div>
    </div>
  );
}

// ─── Route Handler ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // In-memory rate limit — prevents unique-URL cache-bypass abuse.
  // Skip limiting when IP is unidentifiable to avoid a shared "unknown" bucket
  // that a single bad actor could exhaust for all unidentified requests.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")?.trim();
  if (ip && isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
    );
  }

  const { searchParams } = new URL(req.url);

  // Truncate inputs to prevent visual overflow on the fixed-size canvas
  const title = (searchParams.get("title") ?? "AI Weather Intelligence").slice(0, 80);
  const subtitle = (searchParams.get("subtitle") ?? "").slice(0, 120);
  const location = (searchParams.get("location") ?? "").slice(0, 60);
  const province = (searchParams.get("province") ?? "").slice(0, 60);
  const rawTemp = searchParams.get("temp") ?? "";
  const temperature = /^-?\d{1,3}$/.test(rawTemp) ? rawTemp : "";
  const condition = (searchParams.get("condition") ?? "").slice(0, 40);
  const season = (searchParams.get("season") ?? "").slice(0, 40);
  const templateParam = searchParams.get("template") ?? "home";

  const template: TemplateKey = templateParam in TEMPLATES
    ? (templateParam as TemplateKey)
    : "home";

  const element = (
    <OGImage
      title={title}
      subtitle={subtitle}
      location={location}
      province={province}
      temperature={temperature}
      condition={condition}
      season={season}
      template={template}
    />
  );

  try {
    return new ImageResponse(element, {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "OG image generation failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
