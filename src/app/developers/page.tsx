import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/layout/PageShell";
import { CodeBlock } from "@/components/ui/code-block";
import { getCurrentUser } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Developers & Public API",
  description:
    "Free, no-auth public weather API for developers. Current conditions, full forecasts, geo lookup, location search, air quality, and nearest airports — CORS-open and browser-callable, with real curl examples and response shapes.",
  alternates: {
    canonical: "https://weather.mukoko.com/developers",
  },
};
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
      url: SITE_URL,
    },
    publisher: {
      "@type": "Organization",
      name: "Mukoko Africa",
      url: SITE_URL,
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${SITE_URL}/developers`,
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />
      <PageShell>
        <h1 className="elephant">Developers &amp; Public API</h1>
        <p className="mt-4 text-text-secondary leading-relaxed">
          <strong className="text-text-primary">
            The API is free and open — call it directly, no key needed.
          </strong>{" "}
          mukoko weather runs on a set of public JSON endpoints with no account
          and no auth. They&apos;re served with{" "}
          <code className="termite">Access-Control-Allow-Origin: *</code>, so
          you can call them straight from the browser, cross-origin, from any
          site or app. All coordinates are WGS 84 decimal degrees; all
          timestamps are ISO 8601. Want a drop-in widget instead of raw JSON?
          See the{" "}
          <Link href="/embed" prefetch={false} className="sunbird">
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
          <CodeBlock code={`https://weather.mukoko.com`} />
        </section>

        {/* Embed current */}
        <section className="mt-10">
          <h2 className="eagle">Current weather (embed)</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="termite">GET /api/embed/current</code> — a compact
            current-conditions payload built for widgets. Pass a{" "}
            <code className="termite">slug</code> or{" "}
            <code className="termite">lat</code> &amp;{" "}
            <code className="termite">lon</code>. With no parameters it returns
            weather for the visitor&apos;s own location, derived from their IP.
          </p>
          <CodeBlock
            code={`# Visitor's local weather (IP-based)
curl "https://weather.mukoko.com/api/embed/current"

# A specific location by slug
curl "https://weather.mukoko.com/api/embed/current?slug=harare"

# Explicit coordinates
curl "https://weather.mukoko.com/api/embed/current?lat=-17.83&lon=31.05"`}
          />
          <p className="mt-4 text-base text-text-secondary">Response shape:</p>
          <CodeBlock
            code={`{
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
}`}
          />
        </section>

        {/* Full forecast */}
        <section className="mt-10">
          <h2 className="eagle">Full forecast</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="termite">GET /api/py/weather?lat=&amp;lon=</code> —
            the complete forecast: current conditions plus 24-hour hourly and
            7-day daily arrays. The baseline is an Africa-weighted blend of
            global models (ECMWF IFS and AIFS weighted highest, then NOAA GFS,
            DWD ICON, ECCC GEM and Météo-France ARPEGE). Add{" "}
            <code className="termite">&amp;model=</code> (for example{" "}
            <code className="termite">ecmwf_ifs</code>) to base the forecast on
            one model instead, and{" "}
            <code className="termite">&amp;models=</code> (a comma list of{" "}
            <code className="termite">
              ecmwf_ifs,ecmwf_aifs025_single,gfs_seamless,icon_global,gem_global,meteofrance_arpege_world
            </code>
            ) for a Windy-style multi-model comparison. A next-hour
            precipitation nowcast (<code className="termite">minutely</code>,
            four 15-minute steps) is attached automatically when available.
          </p>
          <CodeBlock
            code={`# Full forecast for Harare
curl "https://weather.mukoko.com/api/py/weather?lat=-17.83&lon=31.05"

# With a multi-model comparison
curl "https://weather.mukoko.com/api/py/weather?lat=-17.83&lon=31.05&models=gfs_seamless,ecmwf_ifs"

# Based on a single model
curl "https://weather.mukoko.com/api/py/weather?lat=-17.83&lon=31.05&model=ecmwf_ifs"`}
          />
          <p className="mt-4 text-base text-text-secondary">
            The response carries headers that tell you which provider served
            what: <code className="termite">X-Weather-Provider</code> (the
            forecast baseline —{" "}
            <code className="termite">open-meteo:blend</code> /{" "}
            <code className="termite">open-meteo:&lt;model&gt;</code> /{" "}
            <code className="termite">open-meteo:best_match</code> /{" "}
            <code className="termite">fallback</code>),{" "}
            <code className="termite">X-Enrichment</code> (whether Tomorrow.io
            insights were merged —{" "}
            <code className="termite">tomorrow</code> /{" "}
            <code className="termite">skipped-budget</code> /{" "}
            <code className="termite">skipped-error</code> /{" "}
            <code className="termite">none</code>) and{" "}
            <code className="termite">X-Current-Source</code> (origin of the{" "}
            <code className="termite">current</code> block, which may be{" "}
            <code className="termite">stationkit</code> when a nearby weather
            station is in range).
          </p>
        </section>

        {/* Geo lookup */}
        <section className="mt-10">
          <h2 className="eagle">Nearest location (geo lookup)</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="termite">GET /api/py/geo?lat=&amp;lon=</code> —
            resolves coordinates to the nearest known location (name, slug,
            province, country). Handy for turning a device GPS fix into a place.
          </p>
          <CodeBlock
            code={`curl "https://weather.mukoko.com/api/py/geo?lat=-17.83&lon=31.05"`}
          />
        </section>

        {/* Locations & search */}
        <section className="mt-10">
          <h2 className="eagle">Location lookup &amp; search</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="termite">GET /api/py/locations?slug=</code> fetches
            a single location by slug.{" "}
            <code className="termite">GET /api/py/search?q=</code> runs a text
            search across supported locations.
          </p>
          <CodeBlock
            code={`# Look up a location by slug
curl "https://weather.mukoko.com/api/py/locations?slug=harare"

# Search locations by name
curl "https://weather.mukoko.com/api/py/search?q=nairobi"`}
          />
        </section>

        {/* Air quality */}
        <section className="mt-10">
          <h2 className="eagle">Air quality</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="termite">
              GET /api/py/airquality?lat=&amp;lon=
            </code>{" "}
            — the EPA-standard Air Quality Index (0–500) plus a seven-pollutant
            breakdown (PM2.5, PM10, O₃, NO₂, SO₂, CO, NH₃).
          </p>
          <CodeBlock
            code={`curl "https://weather.mukoko.com/api/py/airquality?lat=-17.83&lon=31.05"`}
          />
        </section>

        {/* Nearest airports */}
        <section className="mt-10">
          <h2 className="eagle">Nearest airports</h2>
          <p className="mt-2 text-base text-text-secondary">
            <code className="termite">
              GET /api/py/airports/nearest?lat=&amp;lon=&amp;count=
            </code>{" "}
            — the N nearest ICAO airports, each with its code, name, and
            distance in kilometres, sorted closest-first.{" "}
            <code className="termite">count</code> defaults to 5 (max 20).
          </p>
          <CodeBlock
            code={`curl "https://weather.mukoko.com/api/py/airports/nearest?lat=-17.83&lon=31.05&count=3"`}
          />
        </section>

        {/* AI endpoints */}
        <section className="mt-10">
          <h2 className="eagle">AI endpoints</h2>
          <p className="mt-2 text-base text-text-secondary">
            mukoko also runs AI-powered weather summaries and a Shamwari-branded
            chatbot backend. These are rate-limited and evolve quickly, so we
            don&apos;t document their internals here
            {isFeatureEnabled("shamwari_chat") ? (
              <>
                {" "}
                — try them live at{" "}
                <Link href="/shamwari" prefetch={false} className="sunbird">
                  Shamwari
                </Link>
                .
              </>
            ) : (
              "."
            )}
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
            loops. Please keep the <code className="termite">attribution</code>{" "}
            back to mukoko weather when you display our data, and credit the
            model providers: forecasts come from ECMWF, NOAA, DWD, ECCC and
            Météo-France via{" "}
            <a
              href="https://open-meteo.com"
              className="sunbird"
              rel="noopener noreferrer"
            >
              Open-Meteo
            </a>{" "}
            (CC BY 4.0), with insights enrichment from{" "}
            <a
              href="https://www.tomorrow.io"
              className="sunbird"
              rel="noopener noreferrer"
            >
              Tomorrow.io
            </a>
            . For a ready-made UI, use the{" "}
            <Link href="/embed" prefetch={false} className="sunbird">
              embeddable widget
            </Link>
            .
          </p>
        </section>
      </PageShell>
    </>
  );
}
