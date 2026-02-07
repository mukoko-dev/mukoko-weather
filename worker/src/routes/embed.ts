/**
 * Embeddable widget system for mukoko weather.
 *
 * Usage on any website:
 *
 *   <!-- Current conditions widget -->
 *   <div data-mukoko-widget="current" data-location="harare"></div>
 *   <script src="https://weather.nyuchi.com/embed/widget.js" async></script>
 *
 *   <!-- Forecast widget -->
 *   <div data-mukoko-widget="forecast" data-location="bulawayo" data-days="5"></div>
 *   <script src="https://weather.nyuchi.com/embed/widget.js" async></script>
 *
 *   <!-- Compact badge -->
 *   <div data-mukoko-widget="badge" data-location="mutare"></div>
 *   <script src="https://weather.nyuchi.com/embed/widget.js" async></script>
 *
 * Widget types:
 *   - "current"  — Current conditions card (temp, conditions, wind, humidity)
 *   - "forecast" — Multi-day forecast strip (configurable 3/5/7 days)
 *   - "badge"    — Compact inline badge (temp + condition, fits in navbars)
 *
 * Attributes:
 *   data-mukoko-widget  — Widget type (required)
 *   data-location       — Location slug (required)
 *   data-days           — Forecast days for "forecast" widget (default: 5)
 *   data-theme          — "light" | "dark" | "auto" (default: "auto")
 *   data-lang           — "en" | "sn" | "nd" (default: "en")
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { getLocationBySlug } from "../data/locations";

export const embedRoutes = new Hono<{ Bindings: Env }>();

// ───── Widget JavaScript loader ─────
embedRoutes.get("/widget.js", (c) => {
  const baseUrl = c.env.NEXT_APP_URL ?? "https://weather.nyuchi.com";
  const script = generateWidgetScript(baseUrl);

  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// ───── Widget CSS ─────
embedRoutes.get("/widget.css", (c) => {
  return new Response(WIDGET_CSS, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// ───── Widget data endpoint (JSON) ─────
embedRoutes.get("/data/:location", async (c) => {
  const slug = c.req.param("location");
  const location = getLocationBySlug(slug);

  if (!location) {
    return c.json({ error: "Unknown location" }, 404);
  }

  // Check weather cache
  const cacheKey = `weather:${location.lat.toFixed(2)}:${location.lon.toFixed(2)}`;
  let weather = await c.env.WEATHER_CACHE.get(cacheKey, { type: "json" }) as Record<string, unknown> | null;

  if (!weather) {
    // Fetch from Open-Meteo
    const params = new URLSearchParams({
      latitude: location.lat.toString(),
      longitude: location.lon.toString(),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,uv_index,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: "Africa/Harare",
      forecast_days: "7",
    });

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) {
      return c.json({ error: "Weather data unavailable" }, 502);
    }
    weather = await res.json() as Record<string, unknown>;
    await c.env.WEATHER_CACHE.put(cacheKey, JSON.stringify(weather), { expirationTtl: 900 });
  }

  return c.json({
    location: {
      name: location.name,
      slug: location.slug,
      province: location.province,
      elevation: location.elevation,
      tags: location.tags,
    },
    weather,
    _meta: {
      source: "mukoko weather by Nyuchi Africa",
      url: `https://weather.nyuchi.com/${slug}`,
    },
  }, 200, {
    "Cache-Control": "public, max-age=900",
    "Access-Control-Allow-Origin": "*",
  });
});

// ───── Iframe embed endpoint ─────
embedRoutes.get("/iframe/:location", (c) => {
  const slug = c.req.param("location");
  const type = c.req.query("type") ?? "current";
  const theme = c.req.query("theme") ?? "auto";
  const baseUrl = c.env.NEXT_APP_URL ?? "https://weather.nyuchi.com";

  const location = getLocationBySlug(slug);
  if (!location) {
    return new Response("Unknown location", { status: 404 });
  }

  const html = generateIframeHtml(baseUrl, slug, location.name, type, theme);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=900",
    },
  });
});

// ────────────────────────────────────
// Widget script generator
// ────────────────────────────────────

function generateWidgetScript(baseUrl: string): string {
  return `(function(){
  "use strict";

  var BASE = "${baseUrl}";
  var CSS_LOADED = false;

  function loadCSS() {
    if (CSS_LOADED) return;
    CSS_LOADED = true;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = BASE + "/embed/widget.css";
    document.head.appendChild(link);
  }

  function weatherLabel(code) {
    var map = {
      0:"Clear sky",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",
      45:"Fog",48:"Fog",51:"Drizzle",53:"Drizzle",55:"Drizzle",
      61:"Rain",63:"Rain",65:"Heavy rain",66:"Freezing rain",67:"Freezing rain",
      71:"Snow",73:"Snow",75:"Snow",80:"Showers",81:"Showers",82:"Heavy showers",
      95:"Thunderstorm",96:"Thunderstorm",99:"Thunderstorm"
    };
    return map[code] || "Unknown";
  }

  function windDir(deg) {
    var dirs = ["N","NE","E","SE","S","SW","W","NW"];
    return dirs[Math.round(deg / 45) % 8];
  }

  function renderCurrent(el, data) {
    var c = data.weather.current;
    var loc = data.location;
    el.innerHTML =
      '<div class="mkw-card">' +
        '<div class="mkw-header">' +
          '<span class="mkw-location">' + loc.name + '</span>' +
          '<span class="mkw-province">' + loc.province + '</span>' +
        '</div>' +
        '<div class="mkw-main">' +
          '<span class="mkw-temp">' + Math.round(c.temperature_2m) + '°C</span>' +
          '<span class="mkw-condition">' + weatherLabel(c.weather_code) + '</span>' +
          '<span class="mkw-feels">Feels like ' + Math.round(c.apparent_temperature) + '°C</span>' +
        '</div>' +
        '<div class="mkw-stats">' +
          '<span>Humidity ' + c.relative_humidity_2m + '%</span>' +
          '<span>Wind ' + Math.round(c.wind_speed_10m) + ' km/h ' + windDir(c.wind_direction_10m) + '</span>' +
          '<span>UV ' + c.uv_index + '</span>' +
        '</div>' +
        '<a class="mkw-link" href="' + data._meta.url + '" target="_blank" rel="noopener">mukoko weather</a>' +
      '</div>';
  }

  function renderForecast(el, data, days) {
    var d = data.weather.daily;
    var loc = data.location;
    var n = Math.min(days || 5, d.time.length);
    var rows = "";
    for (var i = 0; i < n; i++) {
      var date = new Date(d.time[i]);
      var day = i === 0 ? "Today" : date.toLocaleDateString("en-ZW", { weekday: "short" });
      rows +=
        '<div class="mkw-day">' +
          '<span class="mkw-day-name">' + day + '</span>' +
          '<span class="mkw-day-cond">' + weatherLabel(d.weather_code[i]) + '</span>' +
          '<span class="mkw-day-temps">' + Math.round(d.temperature_2m_max[i]) + '° / ' + Math.round(d.temperature_2m_min[i]) + '°</span>' +
        '</div>';
    }
    el.innerHTML =
      '<div class="mkw-card mkw-forecast">' +
        '<div class="mkw-header">' +
          '<span class="mkw-location">' + loc.name + ' Forecast</span>' +
        '</div>' +
        '<div class="mkw-days">' + rows + '</div>' +
        '<a class="mkw-link" href="' + data._meta.url + '" target="_blank" rel="noopener">mukoko weather</a>' +
      '</div>';
  }

  function renderBadge(el, data) {
    var c = data.weather.current;
    var loc = data.location;
    el.innerHTML =
      '<a class="mkw-badge" href="' + data._meta.url + '" target="_blank" rel="noopener">' +
        '<span class="mkw-badge-temp">' + Math.round(c.temperature_2m) + '°C</span>' +
        '<span class="mkw-badge-cond">' + weatherLabel(c.weather_code) + '</span>' +
        '<span class="mkw-badge-loc">' + loc.name + '</span>' +
        '<span class="mkw-badge-brand">mukoko</span>' +
      '</a>';
  }

  function init() {
    loadCSS();
    var widgets = document.querySelectorAll("[data-mukoko-widget]");
    for (var i = 0; i < widgets.length; i++) {
      (function(el) {
        var type = el.getAttribute("data-mukoko-widget");
        var location = el.getAttribute("data-location");
        var days = parseInt(el.getAttribute("data-days") || "5", 10);
        var theme = el.getAttribute("data-theme") || "auto";

        if (!location) { el.textContent = "Missing data-location attribute"; return; }

        if (theme === "dark") el.classList.add("mkw-dark");
        else if (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches) el.classList.add("mkw-dark");

        el.innerHTML = '<div class="mkw-loading">Loading weather...</div>';

        fetch(BASE + "/embed/data/" + encodeURIComponent(location))
          .then(function(r) { if (!r.ok) throw new Error(r.status.toString()); return r.json(); })
          .then(function(data) {
            if (type === "forecast") renderForecast(el, data, days);
            else if (type === "badge") renderBadge(el, data);
            else renderCurrent(el, data);
          })
          .catch(function() {
            el.innerHTML = '<div class="mkw-error">Weather unavailable — <a href="' + BASE + '/' + location + '" target="_blank">view on mukoko weather</a></div>';
          });
      })(widgets[i]);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();`;
}

// ────────────────────────────────────
// Widget CSS
// ────────────────────────────────────

const WIDGET_CSS = `/* mukoko weather — embeddable widget styles */
[data-mukoko-widget] {
  font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
  line-height: 1.5;
  --mkw-bg: #FFFFFF;
  --mkw-bg-subtle: #FAF9F5;
  --mkw-text: #141413;
  --mkw-text-secondary: #52524E;
  --mkw-text-tertiary: #8C8B87;
  --mkw-primary: #4B0082;
  --mkw-border: rgba(140, 139, 135, 0.15);
  --mkw-radius: 16px;
}
[data-mukoko-widget].mkw-dark {
  --mkw-bg: #141414;
  --mkw-bg-subtle: #1E1E1E;
  --mkw-text: #F5F5F4;
  --mkw-text-secondary: #A8A8A3;
  --mkw-text-tertiary: #6B6B66;
  --mkw-primary: #B388FF;
  --mkw-border: rgba(107, 107, 102, 0.2);
}
.mkw-card {
  background: var(--mkw-bg);
  border: 1px solid var(--mkw-border);
  border-radius: var(--mkw-radius);
  padding: 20px;
  max-width: 360px;
}
.mkw-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
}
.mkw-location {
  font-weight: 600;
  font-size: 14px;
  color: var(--mkw-text);
}
.mkw-province {
  font-size: 12px;
  color: var(--mkw-text-tertiary);
}
.mkw-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 16px;
}
.mkw-temp {
  font-size: 48px;
  font-weight: 700;
  color: var(--mkw-text);
  line-height: 1.1;
  font-family: "Noto Serif", Georgia, serif;
}
.mkw-condition {
  font-size: 16px;
  font-weight: 500;
  color: var(--mkw-text);
}
.mkw-feels {
  font-size: 13px;
  color: var(--mkw-text-secondary);
}
.mkw-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--mkw-border);
  font-size: 12px;
  color: var(--mkw-text-secondary);
}
.mkw-link {
  display: block;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--mkw-border);
  font-size: 11px;
  color: var(--mkw-primary);
  text-decoration: none;
  font-weight: 600;
}
.mkw-link:hover { text-decoration: underline; }

/* Forecast widget */
.mkw-forecast { max-width: 440px; }
.mkw-days { display: flex; flex-direction: column; gap: 0; }
.mkw-day {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--mkw-border);
  font-size: 13px;
  color: var(--mkw-text);
}
.mkw-day:last-child { border-bottom: none; }
.mkw-day-name { width: 48px; font-weight: 500; color: var(--mkw-text-secondary); }
.mkw-day-cond { flex: 1; color: var(--mkw-text-secondary); }
.mkw-day-temps { font-weight: 600; font-family: "JetBrains Mono", monospace; font-size: 12px; }

/* Badge widget */
.mkw-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--mkw-bg);
  border: 1px solid var(--mkw-border);
  border-radius: 9999px;
  font-size: 13px;
  color: var(--mkw-text);
  text-decoration: none;
  white-space: nowrap;
}
.mkw-badge:hover { border-color: var(--mkw-primary); }
.mkw-badge-temp { font-weight: 700; }
.mkw-badge-cond { color: var(--mkw-text-secondary); }
.mkw-badge-loc { color: var(--mkw-text-tertiary); font-size: 11px; }
.mkw-badge-brand { color: var(--mkw-primary); font-size: 10px; font-weight: 600; }

/* Loading & error */
.mkw-loading {
  padding: 20px;
  text-align: center;
  color: var(--mkw-text-tertiary);
  font-size: 13px;
}
.mkw-error {
  padding: 16px;
  text-align: center;
  color: var(--mkw-text-secondary);
  font-size: 13px;
}
.mkw-error a { color: var(--mkw-primary); }
`;

// ────────────────────────────────────
// Iframe HTML generator
// ────────────────────────────────────

function generateIframeHtml(
  baseUrl: string,
  slug: string,
  locationName: string,
  type: string,
  theme: string,
): string {
  return `<!DOCTYPE html>
<html lang="en" ${theme === "dark" ? 'class="mkw-dark"' : ""}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${locationName} Weather — mukoko weather</title>
  <link rel="stylesheet" href="${baseUrl}/embed/widget.css">
  <style>
    body { margin: 0; padding: 8px; background: transparent; }
    [data-mukoko-widget] { max-width: 100%; }
  </style>
</head>
<body>
  <div data-mukoko-widget="${type}" data-location="${slug}" ${theme !== "auto" ? `data-theme="${theme}"` : ""} ${theme === "dark" ? 'class="mkw-dark"' : ""}></div>
  <script src="${baseUrl}/embed/widget.js"></script>
</body>
</html>`;
}
