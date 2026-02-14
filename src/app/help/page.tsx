import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "Help & FAQ",
  description:
    "Get help with mukoko weather — how to use forecasts, understand frost alerts, install the app, and more. Frequently asked questions about Zimbabwe's weather intelligence platform.",
  alternates: {
    canonical: "https://weather.mukoko.com/help",
  },
};

const BASE_URL = "https://weather.mukoko.com";

export default function HelpPage() {
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is mukoko weather?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "mukoko weather is Zimbabwe's AI-powered weather intelligence platform. It provides real-time weather conditions, 7-day forecasts, hourly predictions, frost alerts, and AI-generated weather advice for 90+ locations across Zimbabwe.",
        },
      },
      {
        "@type": "Question",
        name: "How accurate is the weather data?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Weather data is sourced from Open-Meteo, which aggregates data from national weather services and global models. Forecasts are generally reliable for 1-3 days ahead. Accuracy decreases for longer-range forecasts. For critical decisions, always consult the Zimbabwe Meteorological Services Department.",
        },
      },
      {
        "@type": "Question",
        name: "How do frost alerts work?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "mukoko weather automatically scans hourly forecasts for temperatures at or below 3°C during nighttime hours (10pm to 8am). Alerts are classified as: Severe (below 0°C), High (0-2°C), or Moderate (2-3°C). These alerts are especially useful for farmers in frost-prone areas like Marondera, Nyanga, and the Eastern Highlands.",
        },
      },
      {
        "@type": "Question",
        name: "Can I install mukoko weather as an app?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. On Android or Huawei phones, open weather.mukoko.com in Chrome or your browser, tap the menu (three dots), and select 'Add to Home Screen' or 'Install App'. The app launches in standalone mode for a native-like experience.",
        },
      },
      {
        "@type": "Question",
        name: "Is mukoko weather free?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes, mukoko weather is completely free. No account, registration, or payment required. Weather is a public good.",
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <Header />
      <main id="main-content" className="mx-auto max-w-3xl px-4 py-10 sm:pl-6 md:pl-8">
        <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">Help & FAQ</h1>
        <p className="mt-3 text-text-secondary">
          Everything you need to know about using mukoko weather.
        </p>

        {/* Getting Started */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Getting started</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <p>
              mukoko weather gives you accurate weather data for 90+ Zimbabwe locations. No account needed —
              just visit{" "}
              <a href={BASE_URL} className="text-primary underline">weather.mukoko.com</a>{" "}
              and you&apos;re ready to go.
            </p>
            <h3 className="font-semibold text-text-primary">Selecting a location</h3>
            <p>
              Tap the location button in the top-right corner of the header. You can:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Search by name (e.g. &quot;Harare&quot;, &quot;Vic Falls&quot;)</li>
              <li>Filter by category — cities, farming areas, mining, tourism, national parks</li>
              <li>Tap &quot;Use my location&quot; to auto-detect your nearest Zimbabwe location</li>
            </ul>

            <h3 className="font-semibold text-text-primary">Using your location</h3>
            <p>
              When you tap &quot;Use my location&quot;, your browser will ask for permission. Your coordinates
              are only used to find the nearest Zimbabwe weather station — they never leave your device. If you
              deny permission, you can always select a location manually.
            </p>
          </div>
        </section>

        {/* Understanding the forecast */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Understanding the forecast</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <h3 className="font-semibold text-text-primary">Current conditions</h3>
            <p>
              The main card shows the current temperature, &quot;feels like&quot; temperature, and weather
              condition (e.g. Clear sky, Partly cloudy, Rain). Below that you&apos;ll find humidity, wind
              speed and direction, UV index, atmospheric pressure, cloud cover, and precipitation.
            </p>

            <h3 className="font-semibold text-text-primary">24-hour forecast</h3>
            <p>
              The hourly forecast shows hour-by-hour predictions for the next 24 hours, including temperature,
              weather icon, and rain probability. Scroll horizontally to see the full timeline.
            </p>

            <h3 className="font-semibold text-text-primary">7-day forecast</h3>
            <p>
              The daily forecast shows each day&apos;s high and low temperatures, weather condition, and rain
              probability. This helps with planning the week ahead.
            </p>

            <h3 className="font-semibold text-text-primary">AI weather summary</h3>
            <p>
              Our AI assistant, <strong className="text-text-primary">Shamwari Weather</strong>, provides a
              contextual summary of current conditions with practical advice. Summaries are tailored to the
              location type — farming areas get crop advice, tourism spots get outdoor activity guidance,
              mining areas get safety tips.
            </p>

            <h3 className="font-semibold text-text-primary">Sunrise & sunset</h3>
            <p>
              Today&apos;s sunrise and sunset times for your selected location, useful for planning outdoor
              activities and understanding daylight hours.
            </p>
          </div>
        </section>

        {/* Frost alerts */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Frost alerts</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <p>
              mukoko weather automatically monitors overnight temperatures and displays a frost alert banner
              when conditions are risky. This is critical for Zimbabwe&apos;s farmers during the cool dry
              season (Chirimo, May–August).
            </p>
            <h3 className="font-semibold text-text-primary">Alert levels</h3>
            <dl className="mt-2 space-y-2">
              <div className="flex gap-3">
                <dt className="w-24 flex-shrink-0 font-semibold text-text-primary">Severe</dt>
                <dd>Below 0°C — protect all crops immediately, cover sensitive plants, drain exposed pipes</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 flex-shrink-0 font-semibold text-text-primary">High</dt>
                <dd>0°C to 2°C — significant frost risk, cover sensitive crops and seedlings</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 flex-shrink-0 font-semibold text-text-primary">Moderate</dt>
                <dd>2°C to 3°C — light frost possible, protect delicate plants</dd>
              </div>
            </dl>
            <p>
              Frost checks run for nighttime hours (10pm to 8am) when frost is most likely. Alerts
              appear as a banner at the top of the weather page.
            </p>
          </div>
        </section>

        {/* Zimbabwe seasons */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Zimbabwe seasons</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <p>
              Zimbabwe has distinct seasons that affect daily life, agriculture, and travel. mukoko weather
              displays the current season badge on every forecast page.
            </p>
            <dl className="mt-2 space-y-3">
              <div>
                <dt className="font-semibold text-text-primary">Masika — Main rains (November–March)</dt>
                <dd className="mt-1">Heavy rainfall, flooding risk, planting season. Roads may be damaged in rural areas.</dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Munakamwe — Short rains (April)</dt>
                <dd className="mt-1">Harvest time, late rains tapering off. Transition period between wet and dry seasons.</dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Chirimo — Cool dry (May–August)</dt>
                <dd className="mt-1">Frost risk, cold snaps, veld fires. The driest and coldest time of year, especially in the Eastern Highlands.</dd>
              </div>
              <div>
                <dt className="font-semibold text-text-primary">Zhizha — Hot dry (September–October)</dt>
                <dd className="mt-1">Heat stress, high UV, water scarcity. The hottest period before the rains return.</dd>
              </div>
            </dl>
          </div>
        </section>

        {/* Install as app */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Install as an app</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <p>
              mukoko weather works as a Progressive Web App (PWA) — you can install it on your phone&apos;s
              home screen for quick access.
            </p>
            <h3 className="font-semibold text-text-primary">Android / Huawei</h3>
            <ol className="list-decimal pl-6 space-y-1">
              <li>Open <strong className="text-text-primary">weather.mukoko.com</strong> in Chrome or your browser</li>
              <li>Tap the <strong className="text-text-primary">menu button</strong> (three dots in the top-right)</li>
              <li>Tap <strong className="text-text-primary">&quot;Add to Home Screen&quot;</strong> or <strong className="text-text-primary">&quot;Install App&quot;</strong></li>
              <li>The app icon will appear on your home screen</li>
            </ol>
            <h3 className="font-semibold text-text-primary">iPhone / iPad</h3>
            <ol className="list-decimal pl-6 space-y-1">
              <li>Open <strong className="text-text-primary">weather.mukoko.com</strong> in Safari</li>
              <li>Tap the <strong className="text-text-primary">Share button</strong> (square with arrow)</li>
              <li>Scroll down and tap <strong className="text-text-primary">&quot;Add to Home Screen&quot;</strong></li>
            </ol>
            <p>
              Once installed, the app opens in standalone mode (no browser address bar) and supports quick
              shortcuts to Harare, Bulawayo, and Victoria Falls weather via long-press on the app icon.
            </p>
          </div>
        </section>

        {/* Dark mode */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Dark mode</h2>
          <div className="mt-4 text-text-secondary leading-relaxed">
            <p>
              Tap the theme toggle button in the top-right corner of the header (next to the location selector)
              to switch between light and dark mode. Your preference is saved and remembered on your next visit.
            </p>
          </div>
        </section>

        {/* Embed widget */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Embed widget</h2>
          <div className="mt-4 text-text-secondary leading-relaxed">
            <p>
              mukoko weather offers an embeddable weather widget for third-party websites. Visit the{" "}
              <Link href="/embed" className="text-primary underline hover:text-primary/80 transition-colors">
                embed page
              </Link>{" "}
              for documentation and code snippets.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Frequently asked questions</h2>
          <div className="mt-4 divide-y divide-text-tertiary/10">
            <details className="group py-4">
              <summary className="cursor-pointer font-semibold text-text-primary group-open:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary focus-visible:rounded">
                Is mukoko weather free?
              </summary>
              <p className="mt-2 text-text-secondary leading-relaxed">
                Yes, completely free. No account, registration, or payment needed. We believe weather
                information is a public good.
              </p>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer font-semibold text-text-primary group-open:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary focus-visible:rounded">
                How accurate is the weather data?
              </summary>
              <p className="mt-2 text-text-secondary leading-relaxed">
                Weather data comes from Open-Meteo, which aggregates global weather models. Short-range
                forecasts (1-3 days) are generally very reliable. Longer-range forecasts (4-7 days) should
                be used as general guidance. For life-critical decisions, always consult the Zimbabwe
                Meteorological Services Department.
              </p>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer font-semibold text-text-primary group-open:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary focus-visible:rounded">
                Do you collect my personal data?
              </summary>
              <p className="mt-2 text-text-secondary leading-relaxed">
                No. We don&apos;t use cookies, analytics, or trackers. If you use the location feature, your
                coordinates stay in your browser and are never sent to our servers. See our{" "}
                <Link href="/privacy" className="text-primary underline">Privacy Policy</Link> for full details.
              </p>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer font-semibold text-text-primary group-open:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary focus-visible:rounded">
                Why can&apos;t I find my location?
              </summary>
              <p className="mt-2 text-text-secondary leading-relaxed">
                We currently cover 90+ Zimbabwe locations including all major cities, farming regions,
                mining areas, national parks, and border posts. If your specific town isn&apos;t listed,
                try the nearest major location — weather conditions are usually similar within 30-50km.
                You can also{" "}
                <a href="https://github.com/nyuchitech/mukoko-weather/issues/new?template=feature_request.md" className="text-primary underline" rel="noopener noreferrer">
                  request a location
                </a>{" "}
                be added.
              </p>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer font-semibold text-text-primary group-open:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary focus-visible:rounded">
                What does the AI summary do?
              </summary>
              <p className="mt-2 text-text-secondary leading-relaxed">
                Our AI assistant (Shamwari Weather) generates a brief, contextual weather summary
                with practical advice. For farming areas, you&apos;ll get crop-related tips. For tourism
                spots, outdoor activity guidance. For mining areas, safety considerations. Summaries are
                refreshed periodically and cached for performance.
              </p>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer font-semibold text-text-primary group-open:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary focus-visible:rounded">
                Does it work offline?
              </summary>
              <p className="mt-2 text-text-secondary leading-relaxed">
                mukoko weather is a PWA (Progressive Web App) and can be installed on your device. However,
                weather data requires an internet connection to fetch the latest conditions. Previously loaded
                pages may be available from your browser cache.
              </p>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer font-semibold text-text-primary group-open:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary focus-visible:rounded">
                Who built mukoko weather?
              </summary>
              <p className="mt-2 text-text-secondary leading-relaxed">
                mukoko weather is a product of Mukoko Africa, a division of Nyuchi Africa (PVT) Ltd. It is
                developed and maintained by Nyuchi Web Services. Learn more on our{" "}
                <Link href="/about" className="text-primary underline">About page</Link>.
              </p>
            </details>
          </div>
        </section>

        {/* Contact */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl font-bold text-text-primary">Still need help?</h2>
          <div className="mt-4 text-text-secondary leading-relaxed">
            <p>Reach out to us:</p>
            <ul className="mt-2 space-y-1">
              <li>
                <strong className="text-text-primary">Support:</strong>{" "}
                <a href="mailto:support@mukoko.com" className="text-primary underline">support@mukoko.com</a>
              </li>
              <li>
                <strong className="text-text-primary">General:</strong>{" "}
                <a href="mailto:hi@mukoko.com" className="text-primary underline">hi@mukoko.com</a>
              </li>
              <li>
                <strong className="text-text-primary">Twitter:</strong>{" "}
                <a href="https://twitter.com/mukokoafrica" className="text-primary underline" rel="noopener noreferrer">@mukokoafrica</a>
              </li>
              <li>
                <strong className="text-text-primary">Instagram:</strong>{" "}
                <a href="https://instagram.com/mukoko.africa" className="text-primary underline" rel="noopener noreferrer">@mukoko.africa</a>
              </li>
            </ul>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
