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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const { location: slug } = await params;
  const loc = getLocationBySlug(slug);
  if (!loc) return { title: "Location not found" };

  return {
    title: `${loc.name} Weather`,
    description: `Current weather conditions and 7-day forecast for ${loc.name}, ${loc.province}, Zimbabwe. AI-powered weather intelligence from mukoko weather.`,
    openGraph: {
      title: `${loc.name} Weather | mukoko weather`,
      description: `Weather forecast for ${loc.name}, Zimbabwe`,
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

  // Schema.org WeatherForecast structured data
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${location.name} Weather Forecast`,
    description: `Current weather and 7-day forecast for ${location.name}, Zimbabwe`,
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

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Header currentLocation={slug} />

      <main
        className="mx-auto max-w-5xl px-4 py-6 sm:pl-6 md:pl-8"
        role="main"
        aria-label={`Weather dashboard for ${location.name}`}
      >
        {/* Season indicator */}
        <div className="mb-4">
          <SeasonBadge />
        </div>

        {/* Frost alert banner */}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

        {/* Main grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left column: Current + AI Summary */}
          <div className="space-y-6 lg:col-span-2">
            <CurrentConditions
              current={weather.current}
              locationName={location.name}
            />
            <AISummary weather={weather} location={location} />
            <HourlyForecast hourly={weather.hourly} />
          </div>

          {/* Right column: Daily + Sun + Info */}
          <div className="space-y-6">
            <DailyForecast daily={weather.daily} />
            <SunTimes daily={weather.daily} />

            {/* Location info card */}
            <section aria-label="Location details">
              <div className="rounded-[var(--radius-card)] bg-surface-card p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-text-primary font-sans">
                  About {location.name}
                </h2>
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-text-tertiary">Province</dt>
                    <dd className="font-medium text-text-primary">{location.province}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-tertiary">Elevation</dt>
                    <dd className="font-medium text-text-primary">{location.elevation}m</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-tertiary">Coordinates</dt>
                    <dd className="font-mono text-xs text-text-primary">
                      {location.lat.toFixed(2)}, {location.lon.toFixed(2)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-tertiary">Season</dt>
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
