import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about mukoko weather — Zimbabwe's AI-powered weather intelligence platform. A Mukoko Africa product, developed by Nyuchi Web Services, a division of Nyuchi Africa (PVT) Ltd.",
  alternates: {
    canonical: "https://weather.mukoko.africa/about",
  },
};

export default function AboutPage() {
  return (
    <>
      <Header currentLocation="" />
      <main id="main-content" className="mx-auto max-w-3xl px-4 py-10 sm:pl-6 md:pl-8">
        <h1 className="font-serif text-3xl font-bold text-text-primary sm:text-4xl">About mukoko weather</h1>

        <section className="mt-8 space-y-4 text-text-secondary leading-relaxed">
          <p>
            <strong className="text-text-primary">mukoko weather</strong> is Zimbabwe&apos;s AI-powered weather
            intelligence platform. We provide accurate, real-time forecasts and actionable weather insights for
            farming, mining, travel, and daily life across 90+ locations nationwide.
          </p>
          <p>
            Our mission is simple: <em>weather as a public good</em>. Every Zimbabwean deserves access to
            reliable, contextual weather information — whether you&apos;re a farmer in Chinhoyi watching for
            frost, a traveller heading to Victoria Falls, or a family in Harare planning the week ahead.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="font-serif text-2xl font-bold text-text-primary">Who we are</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <p>
              <strong className="text-text-primary">mukoko weather</strong> is a product of{" "}
              <strong className="text-text-primary">Mukoko Africa</strong>, a division of{" "}
              <a href="https://nyuchi.com" className="text-primary underline hover:text-primary/80 transition-colors" rel="noopener">
                Nyuchi Africa (PVT) Ltd
              </a>
              .
            </p>
            <p>
              The platform is developed and maintained by{" "}
              <strong className="text-text-primary">Nyuchi Web Services</strong>, the technology arm of Nyuchi
              Africa, building digital products that serve African communities.
            </p>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="font-serif text-2xl font-bold text-text-primary">What we offer</h2>
          <ul className="mt-4 space-y-2 text-text-secondary">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>Real-time weather conditions for 90+ Zimbabwe locations</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>7-day daily forecasts and 24-hour hourly predictions</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>AI-powered weather summaries with contextual advice for farming, mining, travel, and tourism</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>Automated frost alerts for Zimbabwe&apos;s agricultural regions</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>Zimbabwe seasonal awareness — Masika, Chirimo, Zhizha, and Munakamwe</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>Embeddable weather widget for third-party websites</span>
            </li>
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="font-serif text-2xl font-bold text-text-primary">Data sources</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <p>
              Weather data is sourced from{" "}
              <a href="https://open-meteo.com" className="text-primary underline hover:text-primary/80 transition-colors" rel="noopener noreferrer">
                Open-Meteo
              </a>
              , a free and open-source weather API. AI-powered summaries are generated using{" "}
              <a href="https://anthropic.com" className="text-primary underline hover:text-primary/80 transition-colors" rel="noopener noreferrer">
                Anthropic Claude
              </a>
              .
            </p>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="font-serif text-2xl font-bold text-text-primary">Contact us</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex gap-4">
              <dt className="w-28 flex-shrink-0 text-text-tertiary">General</dt>
              <dd>
                <a href="mailto:hi@mukoko.com" className="text-primary underline hover:text-primary/80 transition-colors">
                  hi@mukoko.com
                </a>
              </dd>
            </div>
            <div className="flex gap-4">
              <dt className="w-28 flex-shrink-0 text-text-tertiary">Support</dt>
              <dd>
                <a href="mailto:support@mukoko.com" className="text-primary underline hover:text-primary/80 transition-colors">
                  support@mukoko.com
                </a>
              </dd>
            </div>
            <div className="flex gap-4">
              <dt className="w-28 flex-shrink-0 text-text-tertiary">Legal</dt>
              <dd>
                <a href="mailto:legal@nyuchi.com" className="text-primary underline hover:text-primary/80 transition-colors">
                  legal@nyuchi.com
                </a>
              </dd>
            </div>
            <div className="flex gap-4">
              <dt className="w-28 flex-shrink-0 text-text-tertiary">Twitter</dt>
              <dd>
                <a href="https://twitter.com/mukokoafrica" className="text-primary underline hover:text-primary/80 transition-colors" rel="noopener noreferrer">
                  @mukokoafrica
                </a>
              </dd>
            </div>
            <div className="flex gap-4">
              <dt className="w-28 flex-shrink-0 text-text-tertiary">Instagram</dt>
              <dd>
                <a href="https://instagram.com/mukoko.africa" className="text-primary underline hover:text-primary/80 transition-colors" rel="noopener noreferrer">
                  @mukoko.africa
                </a>
              </dd>
            </div>
          </dl>
        </section>

        <nav className="mt-10 flex gap-4 text-sm" aria-label="Legal pages">
          <Link href="/privacy" className="text-primary underline hover:text-primary/80 transition-colors">
            Privacy Policy
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
