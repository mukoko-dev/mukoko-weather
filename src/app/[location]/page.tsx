import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocationBySlug } from "@/lib/locations";
import { fetchWeather, checkFrostRisk, getZimbabweSeason, weatherCodeToInfo } from "@/lib/weather";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CurrentConditions } from "@/components/weather/CurrentConditions";
import { HourlyForecast } from "@/components/weather/HourlyForecast";
import { DailyForecast } from "@/components/weather/DailyForecast";
import { SunTimes } from "@/components/weather/SunTimes";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { AISummary } from "@/components/weather/AISummary";
import { FrostAlertBanner } from "./FrostAlertBanner";

export const dynamic = "force-dynamic";

const BASE_URL = "https://weather.mukoko.com";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const { location: slug } = await params;
  const loc = getLocationBySlug(slug);
  if (!loc) return { title: "Location not found" };

  const title = `${loc.name} Weather Today — Forecast & Conditions`;
  const description = `Current weather conditions, 7-day forecast, and hourly predictions for ${loc.name}, ${loc.province}, Zimbabwe. AI-powered weather intelligence with frost alerts, farming insights, and accurate temperature data from mukoko weather.`;

  return {
    title,
    description,
    keywords: [
      `${loc.name} weather`,
      `${loc.name} weather today`,
      `${loc.name} forecast`,
      `${loc.name} temperature`,
      `weather in ${loc.name} Zimbabwe`,
      `${loc.province} weather`,
      `${loc.name} 7 day forecast`,
      `${loc.name} rain forecast`,
      "Zimbabwe weather",
      "mukoko weather",
    ],
    alternates: {
      canonical: `${BASE_URL}/${loc.slug}`,
    },
    openGraph: {
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather forecast for ${loc.name}, ${loc.province}, Zimbabwe. Current conditions, 7-day outlook, and AI-powered insights.`,
      url: `${BASE_URL}/${loc.slug}`,
      type: "website",
      locale: "en_ZW",
      siteName: "mukoko weather",
    },
    twitter: {
      card: "summary_large_image",
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather for ${loc.name}, Zimbabwe — current conditions, 7-day forecast, and AI insights.`,
    },
  };
}

export default async function LocationPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const location = getLocationBySlug(slug);
  if (!location) notFound();

  const weather = await fetchWeather(location.lat, location.lon);
  const frostAlert = checkFrostRisk(weather.hourly);
  const season = getZimbabweSeason();
  const conditionInfo = weatherCodeToInfo(weather.current.weather_code);

  // Schema.org structured data — WeatherForecast + Place
  const pageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${location.name} Weather Forecast`,
    description: `Current weather and 7-day forecast for ${location.name}, ${location.province}, Zimbabwe`,
    url: `${BASE_URL}/${location.slug}`,
    mainEntity: {
      "@type": "Place",
      name: location.name,
      geo: {
        "@type": "GeoCoordinates",
        latitude: location.lat,
        longitude: location.lon,
        elevation: location.elevation,
      },
      address: {
        "@type": "PostalAddress",
        addressRegion: location.province,
        addressCountry: "ZW",
      },
    },
    about: {
      "@type": "Observation",
      measurementMethod: "Open-Meteo weather API",
      observationDate: new Date().toISOString(),
      measuredProperty: [
        {
          "@type": "PropertyValue",
          name: "temperature",
          value: weather.current.temperature_2m,
          unitCode: "CEL",
        },
        {
          "@type": "PropertyValue",
          name: "humidity",
          value: weather.current.relative_humidity_2m,
          unitCode: "P1",
        },
        {
          "@type": "PropertyValue",
          name: "windSpeed",
          value: weather.current.wind_speed_10m,
          unitCode: "KMH",
        },
        {
          "@type": "PropertyValue",
          name: "condition",
          value: conditionInfo.label,
        },
      ],
    },
  };

  // BreadcrumbList schema for Google breadcrumbs
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "mukoko weather",
        item: BASE_URL,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: location.province,
        item: `${BASE_URL}/${location.slug}`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: `${location.name} Weather`,
        item: `${BASE_URL}/${location.slug}`,
      },
    ],
  };

  // FAQPage schema for rich snippets and AIO
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What is the weather like in ${location.name} today?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `Currently ${location.name} is ${Math.round(weather.current.temperature_2m)}°C with ${conditionInfo.label.toLowerCase()}. Humidity is ${weather.current.relative_humidity_2m}% with winds at ${Math.round(weather.current.wind_speed_10m)} km/h.`,
        },
      },
      {
        "@type": "Question",
        name: `What is the 7-day forecast for ${location.name}, Zimbabwe?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `The 7-day forecast for ${location.name} shows highs of ${Math.round(Math.max(...weather.daily.temperature_2m_max))}°C and lows of ${Math.round(Math.min(...weather.daily.temperature_2m_min))}°C. Check mukoko weather for detailed daily and hourly forecasts.`,
        },
      },
      {
        "@type": "Question",
        name: `What province is ${location.name} in?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${location.name} is located in ${location.province} province, Zimbabwe, at an elevation of ${location.elevation} metres above sea level.`,
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([pageSchema, breadcrumbSchema, faqSchema]) }}
      />
      <Header currentLocation={slug} />

      {/* Breadcrumb navigation for SEO and accessibility */}
      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-4 sm:pl-6 md:pl-8">
        <ol className="flex items-center gap-1 text-xs text-text-tertiary">
          <li>
            <a href={BASE_URL} className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded">
              Home
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <span className="text-text-secondary">{location.province}</span>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">
            <span className="font-medium text-text-primary">{location.name}</span>
          </li>
        </ol>
      </nav>

      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-hidden px-4 py-6 sm:pl-6 md:pl-8"
        aria-label={`Weather dashboard for ${location.name}`}
      >
        {/* H1 for SEO — visually integrated but semantically correct */}
        <h1 className="sr-only">{location.name} Weather Forecast — Current Conditions and 7-Day Outlook</h1>

        {/* Season indicator */}
        <div className="mb-4">
          <SeasonBadge />
        </div>

        {/* Frost alert banner */}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

        {/* Main grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left column: Current + AI Summary */}
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <CurrentConditions
              current={weather.current}
              locationName={location.name}
            />
            <AISummary weather={weather} location={location} />
            <HourlyForecast hourly={weather.hourly} />
          </div>

          {/* Right column: Daily + Sun + Info */}
          <div className="min-w-0 space-y-6">
            <DailyForecast daily={weather.daily} />
            <SunTimes daily={weather.daily} />

            {/* Location info card */}
            <section aria-labelledby={`about-${location.slug}`}>
              <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
                <h2 id={`about-${location.slug}`} className="text-lg font-semibold text-text-primary font-sans">
                  About {location.name}
                </h2>
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Province</dt>
                    <dd className="font-medium text-text-primary">{location.province}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Elevation</dt>
                    <dd className="font-medium text-text-primary">{location.elevation}m</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Coordinates</dt>
                    <dd className="font-mono text-xs text-text-primary">
                      {location.lat.toFixed(2)}, {location.lon.toFixed(2)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Season</dt>
                    <dd className="font-medium text-text-primary">
                      {season.shona} ({season.name})
                    </dd>
                  </div>
                </dl>
              </div>
            </section>
          </div>
        </div>
      </main>

      <Footer />
    </>
  );
}
