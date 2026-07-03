import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Developers & Public API",
  description:
    "Free, no-auth public weather API for developers. Current conditions, full forecasts, geo lookup, location search, air quality, and nearest airports — CORS-open and browser-callable, with real curl examples and response shapes.",
  alternates: {
    canonical: "https://weather.mukoko.com/developers",
  },
};

const BASE_URL = "https://weather.mukoko.com";

export default async function DevelopersPage() {
  const user = await getCurrentUser();
  const signedIn = user !== null;

  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: "mukoko weather Public API",
    description:
      "Free, no-auth public weather API — current conditions, forecasts, geo lookup, location search, air quality, and nearest airports. CORS-open and browser-callable.",
    inLanguage: "en",
    isPartOf: {
      "@type": "WebSite",
      name: "mukoko weather",
      url: BASE_URL,
    },
    publisher: {
      "@type": "Organization",
      name: "Mukoko Africa",
      url: BASE_URL,
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${BASE_URL}/developers`,
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />
      <Header />
      <main
        id="main-content"
        className="mx-auto max-w-3xl px-4 py-10 pb-24 sm:pb-10 sm:px-6 md:px-8"
      >
        <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">
          Developers &amp; Public API
        </h1>
        <p className="mt-4 text-text-secondary leading-relaxed">
          <strong className="text-text-primary">
            The API is free and open — call it directly, no key needed.
          </strong>{" "}
          mukoko weather runs on a set of public JSON endpoints with no account
          and no auth. They&apos;re served with{" "}
          <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
            Access-Control-Allow-Origin: *
          </code>
          , so you can call them straight from the browser, cross-origin, from
          any site or app. All coordinates are WGS 84 decimal degrees; all
          timestamps are ISO 8601. Want a drop-in widget instead of raw JSON?
          See the{" "}
          <Link
            href="/embed"
            prefetch={false}
            className="text-primary underline hover:text-primary/80 transition-colors"
          >
            embed page
          </Link>
          .
        </p>

        {/* Base URL */}
        <section className="mt-10">
          <h2 className="eagle">Base URL</h2>
          <p className="mt-2 text-base text-text-secondary">
            All endpoints are relative to the production origin:
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`https://weather.mukoko.com`}</code>
            </pre>
          </div>
        </section>

        {/* Embed current */}
        <section className="mt-10">
          <h2 className="eagle">Current weather (embed)</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              GET /api/embed/current
            </code>{" "}
            — a compact current-conditions payload built for widgets. Pass a{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              slug
            </code>{" "}
            or{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              lat
            </code>{" "}
            &amp;{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              lon
            </code>
            . With no parameters it returns weather for the visitor&apos;s own
            location, derived from their IP.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`# Visitor's local weather (IP-based)
curl "https://weather.mukoko.com/api/embed/current"

# A specific location by slug
curl "https://weather.mukoko.com/api/embed/current?slug=harare"

# Explicit coordinates
curl "https://weather.mukoko.com/api/embed/current?lat=-17.83&lon=31.05"`}</code>
            </pre>
          </div>
          <p className="mt-4 text-base text-text-secondary">Response shape:</p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`{
  "location": { "name": "Harare", "province": "Harare",
                "slug": "harare", "country": "ZW" },
  "current":  { "temp": 24, "feelsLike": 23, "code": 2,
                "condition": "Partly cloudy", "high": 27, "low": 14,
                "humidity": 55, "windSpeed": 9, "windDirection": "SE",
                "isDay": true },
  "daily": [ { "date": "2026-06-30", "day": "Today", "code": 2,
               "condition": "Partly cloudy", "high": 27, "low": 14,
               "precipitationProbability": 0 } /* up to 7 */ ],
  "source": "ip",
  "attribution": { "name": "mukoko weather",
                   "url": "https://weather.mukoko.com/harare" }
}`}</code>
            </pre>
          </div>
        </section>

        {/* Full forecast */}
        <section className="mt-10">
          <h2 className="eagle">Full forecast</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              GET /api/py/weather?lat=&amp;lon=
            </code>{" "}
            — the complete forecast: current conditions plus 24-hour hourly and
            7-day daily arrays. Add{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              &amp;models=
            </code>{" "}
            (a comma list of{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              gfs_seamless,ecmwf_ifs04,icon_seamless,meteofrance_seamless
            </code>
            ) for a Windy-style multi-model comparison. A next-hour
            precipitation nowcast (
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              minutely
            </code>
            , four 15-minute steps) is attached automatically when available.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`# Full forecast for Harare
curl "https://weather.mukoko.com/api/py/weather?lat=-17.83&lon=31.05"

# With a multi-model comparison
curl "https://weather.mukoko.com/api/py/weather?lat=-17.83&lon=31.05&models=gfs_seamless,ecmwf_ifs04"`}</code>
            </pre>
          </div>
          <p className="mt-4 text-base text-text-secondary">
            The response carries headers that tell you which provider served
            what:{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              X-Weather-Provider
            </code>{" "}
            (origin of the hourly/daily forecast —{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              tomorrow
            </code>{" "}
            /{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              open-meteo
            </code>{" "}
            /{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              fallback
            </code>
            ) and{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              X-Current-Source
            </code>{" "}
            (origin of the{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              current
            </code>{" "}
            block, which may be{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              stationkit
            </code>{" "}
            when a nearby weather station is in range).
          </p>
        </section>

        {/* Geo lookup */}
        <section className="mt-10">
          <h2 className="eagle">Nearest location (geo lookup)</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              GET /api/py/geo?lat=&amp;lon=
            </code>{" "}
            — resolves coordinates to the nearest known location (name, slug,
            province, country). Handy for turning a device GPS fix into a place.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`curl "https://weather.mukoko.com/api/py/geo?lat=-17.83&lon=31.05"`}</code>
            </pre>
          </div>
        </section>

        {/* Locations & search */}
        <section className="mt-10">
          <h2 className="eagle">Location lookup &amp; search</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              GET /api/py/locations?slug=
            </code>{" "}
            fetches a single location by slug.{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              GET /api/py/search?q=
            </code>{" "}
            runs a text search across supported locations.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`# Look up a location by slug
curl "https://weather.mukoko.com/api/py/locations?slug=harare"

# Search locations by name
curl "https://weather.mukoko.com/api/py/search?q=nairobi"`}</code>
            </pre>
          </div>
        </section>

        {/* Air quality */}
        <section className="mt-10">
          <h2 className="eagle">Air quality</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              GET /api/py/airquality?lat=&amp;lon=
            </code>{" "}
            — the EPA-standard Air Quality Index (0–500) plus a seven-pollutant
            breakdown (PM2.5, PM10, O₃, NO₂, SO₂, CO, NH₃).
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`curl "https://weather.mukoko.com/api/py/airquality?lat=-17.83&lon=31.05"`}</code>
            </pre>
          </div>
        </section>

        {/* Nearest airports */}
        <section className="mt-10">
          <h2 className="eagle">Nearest airports</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              GET /api/py/airports/nearest?lat=&amp;lon=&amp;count=
            </code>{" "}
            — the N nearest ICAO airports, each with its code, name, and
            distance in kilometres, sorted closest-first.{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              count
            </code>{" "}
            defaults to 5 (max 20).
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`curl "https://weather.mukoko.com/api/py/airports/nearest?lat=-17.83&lon=31.05&count=3"`}</code>
            </pre>
          </div>
        </section>

        {/* AI endpoints */}
        <section className="mt-10">
          <h2 className="eagle">AI endpoints</h2>
          <p className="mt-2 text-base text-text-secondary">
            mukoko also runs AI-powered weather summaries and the Shamwari
            chatbot. These are rate-limited and evolve quickly, so we don&apos;t
            document their internals here — try them live at{" "}
            <Link
              href="/shamwari"
              prefetch={false}
              className="text-primary underline hover:text-primary/80 transition-colors"
            >
              Shamwari
            </Link>
            .
          </p>
        </section>

        {/* API keys (optional) */}
        <section className="mt-10">
          <h2 className="eagle">API keys (optional)</h2>
          <p className="mt-2 text-base text-text-secondary leading-relaxed">
            You never need a key for the public endpoints above. API keys are an
            optional extra for registered developers who want{" "}
            <strong className="text-text-primary">higher rate limits</strong>{" "}
            and <strong className="text-text-primary">named attribution</strong>{" "}
            for their traffic. Creating a key requires signing in.
          </p>
          <div className="mt-4 baobab">
            {signedIn ? (
              <>
                <p className="text-base text-text-secondary">
                  You&apos;re signed in{user?.email ? ` as ${user.email}` : ""}{" "}
                  — manage your developer keys below.
                </p>
                <Link
                  href="/developers/keys"
                  prefetch={false}
                  className="kudu press-scale mt-4 inline-flex"
                >
                  Manage API keys
                </Link>
              </>
            ) : (
              <>
                <p className="text-base text-text-secondary">
                  Sign in to create and manage API keys. It&apos;s free — keys
                  just unlock higher limits for registered developers.
                </p>
                <Link
                  href="/auth/signin?returnTo=/developers/keys"
                  prefetch={false}
                  className="kudu press-scale mt-4 inline-flex"
                >
                  Sign in to create an API key
                </Link>
              </>
            )}
          </div>
        </section>

        {/* Terms / fair use */}
        <section className="mt-10 mb-10">
          <h2 className="eagle">Terms &amp; fair use</h2>
          <p className="mt-2 text-base text-text-secondary leading-relaxed">
            These endpoints are free to use — weather is a public good. They are
            rate-limited per IP to keep the service healthy for everyone, so
            cache responses where you can and avoid hammering them in tight
            loops. Please keep the{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              attribution
            </code>{" "}
            back to mukoko weather when you display our data. Weather data is
            sourced from{" "}
            <a
              href="https://www.tomorrow.io"
              className="text-primary underline hover:text-primary/80 transition-colors"
              rel="noopener noreferrer"
            >
              Tomorrow.io
            </a>{" "}
            and{" "}
            <a
              href="https://open-meteo.com"
              className="text-primary underline hover:text-primary/80 transition-colors"
              rel="noopener noreferrer"
            >
              Open-Meteo
            </a>
            . For a ready-made UI, use the{" "}
            <Link
              href="/embed"
              prefetch={false}
              className="text-primary underline hover:text-primary/80 transition-colors"
            >
              embeddable widget
            </Link>
            .
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
