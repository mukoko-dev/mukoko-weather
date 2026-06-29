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
        <p className="mt-2 text-base text-text-tertiary">Last updated: June 2026</p>

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
              If you choose to use the &quot;Use my current location&quot; feature, your browser will ask for
              permission to share your geographic coordinates. This data is:
            </p>
            <ul className="mt-2 list-disc pl-6 space-y-1">
              <li>Used only to determine the nearest supported weather location</li>
              <li>Sent to our server only to find the nearest location — not stored or logged</li>
              <li>Never shared with third parties</li>
            </ul>
            <p className="mt-2">
              You can deny location access and manually select a location instead. The Service works
              fully without location access.
            </p>
            <p className="mt-2">
              When you first visit the Service, we may use your IP address to approximate your location
              via server-side geo-detection (provided automatically by our hosting infrastructure, Vercel).
              Your IP address is not stored — only the approximate location is used to pre-select the
              nearest weather location. You can always choose a different location.
            </p>

            <h3 className="mt-4 font-semibold text-text-primary">Cookies and local storage</h3>
            <p className="mt-2">
              We set a single functional cookie (<code className="text-sm bg-surface-dim px-1 rounded">lastLocation</code>) to remember
              your most recently viewed location and redirect you to it on future visits. This cookie
              expires after 30 days and contains only a location identifier (e.g. &quot;harare&quot;) — no
              personal data.
            </p>
            <p className="mt-2">
              Your preferences (theme, selected activities, saved locations) are stored in your browser&apos;s
              local storage and optionally synced to an anonymous device profile in our database (see
              &quot;Device preferences sync&quot; below). No personal data is stored in local storage.
            </p>

            <h3 className="mt-4 font-semibold text-text-primary">Device preferences sync</h3>
            <p className="mt-2">
              To sync your preferences across devices (theme, saved locations, activity selections), the
              Service generates a random anonymous device identifier (UUID) stored in your browser&apos;s
              local storage. This UUID, along with your preference settings, is stored in our database.
              The UUID contains no personal information and cannot identify you. You can clear it by
              clearing your browser&apos;s local storage.
            </p>

            <h3 className="mt-4 font-semibold text-text-primary">Community weather reports</h3>
            <p className="mt-2">
              If you submit a community weather report (e.g. reporting current rain or frost conditions),
              the following is stored:
            </p>
            <ul className="mt-2 list-disc pl-6 space-y-1">
              <li>The report type and severity you selected</li>
              <li>The location you were viewing</li>
              <li>A one-way cryptographic hash of your IP address (used only for rate limiting — cannot be reversed to identify you)</li>
              <li>The timestamp</li>
            </ul>
            <p className="mt-2">
              Reports are automatically deleted after 24–72 hours depending on severity. Your raw IP
              address is never stored.
            </p>

            <h3 className="mt-4 font-semibold text-text-primary">Automatically collected information</h3>
            <p className="mt-2">
              We use <strong className="text-text-primary">Google Analytics</strong> to understand how our
              service is used. Google Analytics collects anonymised usage data including page views,
              approximate geographic region, browser type, and device category. This data is aggregated
              and cannot identify you personally.
            </p>
            <p className="mt-2">
              Google Analytics uses cookies to distinguish unique visitors. You can opt out by installing the{" "}
              <a href="https://tools.google.com/dlpage/gaoptout" className="text-primary underline" rel="noopener noreferrer">
                Google Analytics Opt-out Browser Add-on
              </a>.
            </p>
            <p className="mt-2">
              We also use <strong className="text-text-primary">Vercel Web Analytics</strong> to monitor
              website performance. Vercel Analytics does not use cookies and collects no personally
              identifiable information.
            </p>
            <p className="mt-2">
              We do not use advertising pixels, fingerprinting technologies, or any tracking beyond
              Google Analytics and Vercel Analytics.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Third-party services</h2>
            <p className="mt-3">mukoko weather uses the following third-party services:</p>
            <dl className="mt-3 space-y-3">
              <div>
                <dt className="font-semibold text-text-primary">Open-Meteo</dt>
                <dd className="mt-1">
                  Weather data API. We send geographic coordinates of supported locations to retrieve
                  weather forecasts. No personal data is transmitted.
                  See their <a href="https://open-meteo.com/en/terms" className="text-primary underline" rel="noopener noreferrer">terms</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Tomorrow.io</dt>
                <dd className="mt-1">
                  Primary weather data API and weather map tile provider. We send geographic coordinates
                  to retrieve weather forecasts and overlay map imagery. No personal data is transmitted.
                  See their <a href="https://www.tomorrow.io/privacy-policy/" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">MapTiler Cloud</dt>
                <dd className="mt-1">
                  Map tile provider for base map rendering. MapTiler receives tile requests from your browser
                  which include your IP address as part of standard web requests. No personal data beyond
                  standard request metadata is transmitted.
                  See their <a href="https://www.maptiler.com/privacy-policy/" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Aviation Weather Center (NOAA)</dt>
                <dd className="mt-1">
                  Official METAR and TAF aviation weather data provider. We request aviation weather
                  observations by ICAO airport code. No personal data is transmitted.
                  See their <a href="https://www.aviationweather.gov/disclaimer" className="text-primary underline" rel="noopener noreferrer">terms</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">OpenStreetMap / Nominatim</dt>
                <dd className="mt-1">
                  Reverse geocoding used when creating new locations. We send geographic coordinates
                  to determine place names. No personal data is transmitted.
                  See their <a href="https://osmfoundation.org/wiki/Privacy_Policy" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Anthropic Claude</dt>
                <dd className="mt-1">
                  AI model used to generate weather summaries and power the Shamwari chatbot. Only weather
                  data, location names, and your chat messages are sent — no personal data. Processing
                  occurs on our server, not in your browser. Chat messages are not stored beyond the
                  duration of your session.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Google Analytics &amp; Google Fonts</dt>
                <dd className="mt-1">
                  Analytics and font files. Google may collect standard web request information.
                  See their <a href="https://policies.google.com/privacy" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Vercel</dt>
                <dd className="mt-1">
                  Hosting and serverless infrastructure. Vercel processes requests on our behalf and
                  may collect standard server logs. Your IP address is used transiently for location
                  approximation and is not stored by us.
                  See their <a href="https://vercel.com/legal/privacy-policy" className="text-primary underline" rel="noopener noreferrer">privacy policy</a>.
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Data retention</h2>
            <p className="mt-3">
              We do not retain personal data. Specific retention periods:
            </p>
            <ul className="mt-2 list-disc pl-6 space-y-1">
              <li>AI-generated weather summaries: cached 30–120 minutes, then auto-deleted</li>
              <li>Community weather reports: auto-deleted after 24–72 hours depending on severity</li>
              <li>Device preference profiles: retained until you clear your browser local storage or request deletion</li>
              <li>Rate limiting records: auto-deleted after expiry window (typically 1 hour)</li>
            </ul>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">International users</h2>
            <p className="mt-3">
              mukoko weather serves users globally. If you access the Service from outside Zimbabwe,
              data may be processed in countries other than your own (including the United States, where
              our hosting and AI services operate). By using the Service, you consent to such transfers.
              We apply the same privacy protections to all users regardless of location.
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
            <h2 className="font-heading text-xl font-bold text-text-primary">Your rights</h2>
            <p className="mt-3">
              Since we collect no personal data tied to your identity, there is nothing to access, correct,
              or delete. If you wish to remove your anonymous device preference profile, clearing your
              browser local storage achieves this. For any other requests, contact us at the address below.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Changes to this policy</h2>
            <p className="mt-3">
              We may update this Privacy Policy from time to time. Changes will be posted on this page
              with an updated date. Your continued use of the Service after changes constitutes acceptance
              of the revised policy.
            </p>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-text-primary">Contact</h2>
            <p className="mt-3">For privacy-related questions or concerns, contact us at:</p>
            <ul className="mt-2 space-y-1">
              <li><a href="mailto:legal@nyuchi.com" className="text-primary underline">legal@nyuchi.com</a></li>
              <li><a href="mailto:support@mukoko.com" className="text-primary underline">support@mukoko.com</a></li>
            </ul>
            <p className="mt-3 text-base text-text-tertiary">
              Mukoko Africa, a division of Nyuchi Africa (PVT) Ltd
            </p>
          </section>
        </div>

        <nav className="mt-10 flex gap-4 text-base" aria-label="Legal pages">
          <Link href="/about" className="text-primary underline hover:text-primary/80 transition-colors">About</Link>
          <Link href="/terms" className="text-primary underline hover:text-primary/80 transition-colors">Terms of Service</Link>
        </nav>
      </main>
      <Footer />
    </>
  );
}
