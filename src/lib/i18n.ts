/**
 * Lightweight i18n infrastructure for mukoko weather.
 *
 * Makes the app translation-ready without adding a heavy i18n library.
 * Currently supports English (en) with structural readiness for Shona (sn)
 * and Ndebele (nd).
 *
 * Usage:
 *   import { t, formatTemp, formatDate, formatTime } from "@/lib/i18n";
 *   t("weather.feelsLike")  // "Feels like"
 *   formatTemp(28)          // "28°C"
 */

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "sn", "nd"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// ── Messages ────────────────────────────────────────────────────────────

const messages: Record<string, Record<string, string>> = {
  en: {
    // Navigation
    "nav.home": "Home",
    "nav.skipToContent": "Skip to main content",
    "nav.selectLocation": "Select location",
    "nav.searchLocations": "Search locations...",
    "nav.useMyLocation": "Use my location",
    "nav.detectingLocation": "Detecting location...",
    "nav.locationDenied": "Location access denied. Enable it in your browser settings.",
    "nav.outsideZw": "You appear to be outside Zimbabwe. Select a location below.",

    // Weather
    "weather.current": "Current weather conditions in {location}",
    "weather.feelsLike": "Feels like",
    "weather.humidity": "Humidity",
    "weather.wind": "Wind",
    "weather.uvIndex": "UV Index",
    "weather.pressure": "Pressure",
    "weather.cloudCover": "Cloud Cover",
    "weather.precipitation": "Precipitation",
    "weather.hourlyForecast": "24-Hour Forecast",
    "weather.dailyForecast": "7-Day Forecast",
    "weather.now": "Now",
    "weather.today": "Today",
    "weather.sunrise": "Sunrise",
    "weather.sunset": "Sunset",
    "weather.sun": "Sun",

    // Frost alerts
    "frost.warning": "Frost Warning",
    "frost.advisory": "Frost Advisory",
    "frost.severe": "SEVERE",
    "frost.high": "HIGH",
    "frost.moderate": "MODERATE",

    // AI
    "ai.title": "Shamwari Weather Insight",
    "ai.loading": "Loading AI weather summary...",
    "ai.error": "Unable to load AI summary. Weather data is still available above.",
    "ai.poweredBy": "Powered by Shamwari AI",

    // Seasons
    "season.mainRains": "Main rains",
    "season.shortRains": "Short rains",
    "season.coolDry": "Cool dry",
    "season.hotDry": "Hot dry",

    // Location info
    "location.about": "About {location}",
    "location.province": "Province",
    "location.elevation": "Elevation",
    "location.coordinates": "Coordinates",
    "location.season": "Season",
    "location.count": "{count} locations across Zimbabwe",

    // Footer
    "footer.copyright": "Nyuchi Africa (PVT) Ltd",
    "footer.product": "A Mukoko Africa product.",
    "footer.weatherData": "Weather data by",
    "footer.ubuntu": "Built with Ubuntu philosophy — weather as a public good.",

    // Pages
    "page.about": "About",
    "page.privacy": "Privacy",
    "page.terms": "Terms",
    "page.help": "Help",
    "page.contact": "Contact",

    // Accessibility
    "a11y.lightMode": "Switch to light mode",
    "a11y.darkMode": "Switch to dark mode",
    "a11y.temperatureLabel": "{value} degrees Celsius",
    "a11y.highTemp": "High {value} degrees",
    "a11y.lowTemp": "Low {value} degrees",
  },
};

// ── Translation function ────────────────────────────────────────────────

/**
 * Look up a translation key. Supports simple interpolation with {param}.
 * Falls back to the key itself if not found.
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const localeMessages = messages[locale] ?? messages[DEFAULT_LOCALE];
  let text = localeMessages[key] ?? messages[DEFAULT_LOCALE]?.[key] ?? key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }

  return text;
}

// ── Formatting utilities using Intl APIs ────────────────────────────────

const LOCALE_MAP: Record<Locale, string> = {
  en: "en-ZW",
  sn: "sn-ZW",
  nd: "nd-ZW",
};

/** Format temperature with unit, e.g. "28°C" */
export function formatTemp(value: number, locale: Locale = DEFAULT_LOCALE): string {
  const intlLocale = LOCALE_MAP[locale] ?? "en-ZW";
  return new Intl.NumberFormat(intlLocale, {
    style: "unit",
    unit: "celsius",
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

/** Format wind speed, e.g. "12 km/h" */
export function formatWindSpeed(value: number, locale: Locale = DEFAULT_LOCALE): string {
  const intlLocale = LOCALE_MAP[locale] ?? "en-ZW";
  return new Intl.NumberFormat(intlLocale, {
    style: "unit",
    unit: "kilometer-per-hour",
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

/** Format percentage, e.g. "62%" */
export function formatPercent(value: number, locale: Locale = DEFAULT_LOCALE): string {
  const intlLocale = LOCALE_MAP[locale] ?? "en-ZW";
  return new Intl.NumberFormat(intlLocale, {
    style: "unit",
    unit: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Format time (24h), e.g. "14:30" */
export function formatTime(date: Date, locale: Locale = DEFAULT_LOCALE): string {
  const intlLocale = LOCALE_MAP[locale] ?? "en-ZW";
  return new Intl.DateTimeFormat(intlLocale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Format day name, e.g. "Mon" */
export function formatDayName(date: Date, locale: Locale = DEFAULT_LOCALE): string {
  const intlLocale = LOCALE_MAP[locale] ?? "en-ZW";
  return new Intl.DateTimeFormat(intlLocale, { weekday: "short" }).format(date);
}

/** Format full date, e.g. "9 February 2026" */
export function formatDate(date: Date, locale: Locale = DEFAULT_LOCALE): string {
  const intlLocale = LOCALE_MAP[locale] ?? "en-ZW";
  return new Intl.DateTimeFormat(intlLocale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}
