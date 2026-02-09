/**
 * nyuchi-weather-api — Cloudflare Worker
 *
 * Edge API layer for mukoko weather at weather.mukoko.com
 *
 * Routes:
 *   GET  /api/weather?lat=&lon=         — Cached Open-Meteo weather proxy
 *   GET  /api/geo?lat=&lon=             — Nearest Zimbabwe location lookup
 *   POST /api/ai                        — AI weather summary (KV-cached)
 *   GET  /api/locations                 — All Zimbabwe locations
 *   GET  /api/locations/:tag            — Locations filtered by tag
 *   GET  /embed/widget.js              — Embeddable widget script
 *   GET  /embed/widget.css             — Widget styles
 *   GET  /embed/current/:location      — Widget data endpoint
 *   *    /*                             — Proxy to Next.js app
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { weatherRoutes } from "./routes/weather";
import { aiRoutes } from "./routes/ai";
import { geoRoutes } from "./routes/geo";
import { locationRoutes } from "./routes/locations";
import { embedRoutes } from "./routes/embed";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

// ───── CORS ─────
app.use("/api/*", async (c, next) => {
  const origins = c.env.CORS_ORIGINS?.split(",").map((s) => s.trim()) ?? ["*"];
  return cors({
    origin: origins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  })(c, next);
});

app.use("/embed/*", async (c, next) => {
  // Embeds need to be loadable from any origin
  return cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 86400 })(c, next);
});

// ───── Health check ─────
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    service: "nyuchi-weather-api",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});

// ───── API Routes ─────
app.route("/api/weather", weatherRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/geo", geoRoutes);
app.route("/api/locations", locationRoutes);

// ───── Embed Routes ─────
app.route("/embed", embedRoutes);

// ───── Catch-all: proxy to Next.js ─────
app.all("*", async (c) => {
  const nextUrl = c.env.NEXT_APP_URL ?? "http://localhost:3000";
  const url = new URL(c.req.url);
  const proxyUrl = `${nextUrl}${url.pathname}${url.search}`;

  const res = await fetch(proxyUrl, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
  });

  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
});

export default app;
