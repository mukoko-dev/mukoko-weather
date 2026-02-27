import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Privacy Policy for mukoko weather. Learn how we handle your data — spoiler: we collect almost nothing.",
  alternates: {
    canonical: "https://weather.mukoko.com/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <>
      <Header />
      <main id="main-content" className="mx-auto max-w-3xl px-4 py-10 pb-24 sm:pb-10 sm:px-6 md:px-8">
        <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">Privacy Policy</h1>
        <p className="mt-2 text-base text-text-tertiary">Last updated: February 2026</p>

        <div className="mt-8 space-y-8 text-text-secondary leading-relaxed">
          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Introduction</h2>
            <p className="mt-3">
              This Privacy Policy explains how <strong className="text-text-primary">Mukoko Africa</strong>,
              a division of <strong className="text-text-primary">Nyuchi Africa (PVT) Ltd</strong>
              (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;), handles information when you use mukoko weather
              (&quot;the Service&quot;) at{" "}
              <a href="https://weather.mukoko.com" className="text-primary underline">weather.mukoko.com</a>.
            </p>
            <p className="mt-3">
              We are committed to your privacy. mukoko weather is designed to provide weather intelligence
              with minimal data collection.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Information we collect</h2>
            <h3 className="mt-4 font-semibold text-text-primary">Information you provide</h3>
            <p className="mt-2">
              mukoko weather does not require account creation, registration, or login. We do not collect
              your name, email address, phone number, or any other personal information.
            </p>

            <h3 className="mt-4 font-semibold text-text-primary">Location data</h3>
            <p className="mt-2">
              If you choose to use the &quot;Use my location&quot; feature, your browser will ask for permission
              to share your geographic coordinates. This data is:
            </p>
            <ul className="mt-2 list-disc pl-6 space-y-1">
              <li>Processed entirely in your browser (client-side)</li>
              <li>Used only to determine the nearest supported weather location</li>
              <li>Sent to our server only to find the nearest location — not stored or logged</li>
              <li>Never shared with third parties</li>
            </ul>
            <p className="mt-2">
              You can deny location access and manually select a location instead. The Service works
              fully without location access.
            </p>

            <h3 className="mt-4 font-semibold text-text-primary">Automatically collected information</h3>
            <p className="mt-2">
              We use <strong className="text-text-primary">Google Analytics</strong> to understand how our
              service is used — such as which locations are most popular and how visitors navigate the site.
              Google Analytics collects anonymised usage data including page views, approximate geographic
              region, browser type, and device category. This data is aggregated and cannot identify you
              personally.
            </p>
            <p className="mt-2">
              Google Analytics uses cookies to distinguish unique visitors. You can opt out of Google
              Analytics by installing the{" "}
              <a href="https://tools.google.com/dlpage/gaoptout" className="text-primary underline" rel="noopener noreferrer">
                Google Analytics Opt-out Browser Add-on
              </a>.
            </p>
            <p className="mt-2">
              In addition to page views, we track anonymised user interaction events such as location
              selections, activity preferences, theme changes, search queries, and weather report submissions.
              These events contain no personally identifiable information — only action names and metadata
              like location slugs and activity IDs. This data helps us understand which features are used
              and improve the service.
            </p>
            <p className="mt-2">
              We also use <strong className="text-text-primary">Vercel Web Analytics</strong> to monitor
              website performance (Core Web Vitals) and track the same anonymised interaction events.
              Vercel Analytics does not use cookies and collects no personally identifiable information.
            </p>
            <p className="mt-2">
              We do not use advertising pixels, fingerprinting technologies, or any other tracking beyond
              Google Analytics and Vercel Analytics. Our hosting provider (Cloudflare) may collect standard
              web server logs (IP address, browser type, request time) as part of their infrastructure.
              We do not access or analyse these logs.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">How we use information</h2>
            <p className="mt-3">
              Since we collect minimal information, our use is limited to:
            </p>
            <ul className="mt-2 list-disc pl-6 space-y-1">
              <li>Serving weather data for the location you select or navigate to</li>
              <li>Generating AI-powered weather summaries (using only weather data and location name — no personal information)</li>
              <li>Caching AI-generated weather summaries by location slug to improve performance (no personal data is cached)</li>
            </ul>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Third-party services</h2>
            <p className="mt-3">mukoko weather uses the following third-party services:</p>
            <dl className="mt-3 space-y-3">
              <div>
                <dt className="font-semibold text-text-primary">Open-Meteo</dt>
                <dd className="mt-1">
                  Weather data API. We send geographic coordinates (latitude/longitude of supported locations)
                  to retrieve weather forecasts. No personal data is transmitted.
                  See their <a href="https://open-meteo.com/en/terms" className="text-primary underline" rel="noopener noreferrer">terms</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Tomorrow.io</dt>
                <dd className="mt-1">
                  Primary weather data API. We send geographic coordinates to retrieve weather forecasts
                  and map tile imagery. No personal data is transmitted.
                  See their <a href="https://www.tomorrow.io/privacy-policy/" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">OpenStreetMap / Nominatim</dt>
                <dd className="mt-1">
                  Reverse geocoding API used when creating new locations. We send geographic coordinates
                  to determine place names. No personal data is transmitted.
                  See their <a href="https://osmfoundation.org/wiki/Privacy_Policy" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Anthropic Claude</dt>
                <dd className="mt-1">
                  AI model used to generate weather summaries. Only weather data and location names are sent —
                  no personal data. Processing occurs on our server, not in your browser.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Google Analytics</dt>
                <dd className="mt-1">
                  Anonymised website usage analytics. Collects aggregated data on page views, visitor counts,
                  and navigation patterns. No personally identifiable information is collected.
                  See their <a href="https://policies.google.com/privacy" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Google Fonts</dt>
                <dd className="mt-1">
                  Font files are loaded from Google&apos;s servers. Google may collect standard web request
                  information. See their <a href="https://policies.google.com/privacy" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Cloudflare</dt>
                <dd className="mt-1">
                  Hosting and CDN provider. Cloudflare may collect standard server logs as part of their
                  infrastructure. See their <a href="https://www.cloudflare.com/privacypolicy/" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Data retention</h2>
            <p className="mt-3">
              We do not retain any personal data. AI-generated weather summaries are cached for 30-120
              minutes depending on the location, after which they are automatically regenerated. These
              caches contain only weather information, not user data.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">International users</h2>
            <p className="mt-3">
              mukoko weather serves users in multiple countries. If you access the Service from outside
              Zimbabwe, please be aware that data may be processed in countries other than your own.
              By using the Service, you consent to the transfer of information as described in this
              Privacy Policy. We apply the same privacy protections to all users regardless of location.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Children&apos;s privacy</h2>
            <p className="mt-3">
              mukoko weather is a general-audience weather service. We do not knowingly collect any personal
              information from anyone, including children under 13.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Changes to this policy</h2>
            <p className="mt-3">
              We may update this Privacy Policy from time to time. Changes will be posted on this page with
              an updated date. Your continued use of the Service after changes constitutes acceptance of the
              revised policy.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Contact</h2>
            <p className="mt-3">
              For privacy-related questions or concerns, contact us at:
            </p>
            <ul className="mt-2 space-y-1">
              <li>
                <a href="mailto:legal@nyuchi.com" className="text-primary underline">legal@nyuchi.com</a>
              </li>
              <li>
                <a href="mailto:support@mukoko.com" className="text-primary underline">support@mukoko.com</a>
              </li>
            </ul>
            <p className="mt-3 text-base text-text-tertiary">
              Mukoko Africa, a division of Nyuchi Africa (PVT) Ltd
            </p>
          </section>
        </div>

        <nav className="mt-10 flex gap-4 text-base" aria-label="Legal pages">
          <Link href="/about" className="text-primary underline hover:text-primary/80 transition-colors">
            About
          </Link>
          <Link href="/terms" className="text-primary underline hover:text-primary/80 transition-colors">
            Terms of Service
          </Link>
        </nav>
      </main>
      <Footer />
    </>
  );
}
