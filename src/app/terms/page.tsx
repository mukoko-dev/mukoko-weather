import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms of Service for mukoko weather — Zimbabwe's AI-powered weather intelligence platform, operated by Mukoko Africa, a division of Nyuchi Africa (PVT) Ltd.",
  alternates: {
    canonical: "https://weather.mukoko.com/terms",
  },
};

export default function TermsPage() {
  return (
    <>
      <Header currentLocation="" />
      <main id="main-content" className="mx-auto max-w-3xl px-4 py-10 sm:pl-6 md:pl-8">
        <h1 className="font-serif text-3xl font-bold text-text-primary sm:text-4xl">Terms of Service</h1>
        <p className="mt-2 text-sm text-text-tertiary">Last updated: February 2026</p>

        <div className="mt-8 space-y-8 text-text-secondary leading-relaxed">
          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">1. Agreement</h2>
            <p className="mt-3">
              These Terms of Service (&quot;Terms&quot;) govern your use of mukoko weather
              (&quot;the Service&quot;), operated by <strong className="text-text-primary">Mukoko Africa</strong>,
              a division of <strong className="text-text-primary">Nyuchi Africa (PVT) Ltd</strong>
              (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;). The Service is developed by
              Nyuchi Web Services.
            </p>
            <p className="mt-3">
              By accessing or using the Service at{" "}
              <a href="https://weather.mukoko.com" className="text-primary underline">weather.mukoko.com</a>,
              you agree to be bound by these Terms. If you do not agree, please do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">2. Description of Service</h2>
            <p className="mt-3">
              mukoko weather provides weather forecasts, current conditions, AI-generated weather summaries,
              and frost alerts for locations across Zimbabwe. The Service is provided free of charge.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">3. Weather data disclaimer</h2>
            <p className="mt-3">
              Weather information provided by the Service is sourced from third-party data providers
              (Open-Meteo) and AI models (Anthropic Claude). While we strive for accuracy:
            </p>
            <ul className="mt-2 list-disc pl-6 space-y-1">
              <li>Weather forecasts are inherently uncertain and should be used as guidance, not guarantees</li>
              <li>AI-generated summaries are informational and should not be the sole basis for critical decisions</li>
              <li>Frost alerts are automated estimates and do not replace professional agricultural advice</li>
              <li>We do not guarantee the accuracy, completeness, or timeliness of any weather data</li>
            </ul>
            <p className="mt-3">
              For critical decisions affecting life, property, or agriculture, always consult the
              Zimbabwe Meteorological Services Department and relevant professional advisors.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">4. Acceptable use</h2>
            <p className="mt-3">You may use the Service for personal, educational, and commercial purposes. You may not:</p>
            <ul className="mt-2 list-disc pl-6 space-y-1">
              <li>Attempt to disrupt, overload, or interfere with the Service&apos;s infrastructure</li>
              <li>Use automated systems to scrape or harvest data at a rate that impacts other users</li>
              <li>Misrepresent the Service as your own product or remove attribution</li>
              <li>Use the Service for any unlawful purpose</li>
            </ul>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">5. API and embed usage</h2>
            <p className="mt-3">
              The Service provides API endpoints and an embeddable widget. These are provided for
              reasonable use. We reserve the right to rate-limit or restrict access to API endpoints
              if usage is excessive or impacts the Service for other users.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">6. Intellectual property</h2>
            <p className="mt-3">
              The mukoko weather name, logo, and brand are trademarks of Mukoko Africa / Nyuchi Africa (PVT) Ltd.
              The Service&apos;s source code is licensed under the{" "}
              <a href="https://github.com/nyuchitech/mukoko-weather/blob/main/LICENSE" className="text-primary underline" rel="noopener noreferrer">
                MIT License
              </a>
              . Weather data is provided by Open-Meteo under their respective terms.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">7. Limitation of liability</h2>
            <p className="mt-3">
              THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES
              OF ANY KIND, EITHER EXPRESS OR IMPLIED. TO THE FULLEST EXTENT PERMITTED BY LAW, NYUCHI
              AFRICA (PVT) LTD AND ITS DIVISIONS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
              SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM YOUR USE OF THE SERVICE.
            </p>
            <p className="mt-3">
              This includes, without limitation, damages for loss of crops, business interruption,
              travel disruption, or any decisions made based on weather information from the Service.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">8. Service availability</h2>
            <p className="mt-3">
              We aim to keep the Service available at all times but do not guarantee uninterrupted access.
              The Service may be temporarily unavailable due to maintenance, updates, or circumstances
              beyond our control. We reserve the right to modify or discontinue the Service at any time.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">9. Changes to these Terms</h2>
            <p className="mt-3">
              We may update these Terms from time to time. Changes will be posted on this page with an
              updated date. Your continued use of the Service after changes constitutes acceptance of the
              revised Terms.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">10. Governing law</h2>
            <p className="mt-3">
              These Terms are governed by the laws of the Republic of Zimbabwe. Any disputes arising from
              these Terms or your use of the Service shall be subject to the jurisdiction of the courts
              of Zimbabwe.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-xl font-bold text-text-primary">11. Contact</h2>
            <p className="mt-3">
              For questions about these Terms, contact us at:
            </p>
            <ul className="mt-2 space-y-1">
              <li>
                <a href="mailto:legal@nyuchi.com" className="text-primary underline">legal@nyuchi.com</a>
              </li>
              <li>
                <a href="mailto:support@mukoko.com" className="text-primary underline">support@mukoko.com</a>
              </li>
            </ul>
            <p className="mt-3 text-sm text-text-tertiary">
              Mukoko Africa, a division of Nyuchi Africa (PVT) Ltd
            </p>
          </section>
        </div>

        <nav className="mt-10 flex gap-4 text-sm" aria-label="Legal pages">
          <Link href="/about" className="text-primary underline hover:text-primary/80 transition-colors">
            About
          </Link>
          <Link href="/privacy" className="text-primary underline hover:text-primary/80 transition-colors">
            Privacy Policy
          </Link>
        </nav>
      </main>
      <Footer />
    </>
  );
}
