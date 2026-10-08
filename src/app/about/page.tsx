import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/layout/PageShell";
import { InfoRow } from "@/components/ui/info-row";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about mukoko weather — an AI-powered global weather intelligence platform providing forecasts for farming, mining, travel, and daily life worldwide. A Mukoko Africa product by Nyuchi Web Services.",
  alternates: {
    canonical: "https://weather.mukoko.com/about",
  },
};

const OFFERINGS = [
  "Real-time weather conditions for 265+ locations worldwide",
  "7-day daily forecasts and 24-hour hourly predictions",
  "AI-powered weather summaries with contextual advice for farming, mining, travel, and tourism",
  "Automated frost alerts for agricultural regions",
  "Country-specific seasonal awareness with local season names and agricultural calendars",
  "Embeddable weather widget for third-party websites",
];

const CONTACTS = [
  { label: "General", href: "mailto:hi@mukoko.com", text: "hi@mukoko.com" },
  {
    label: "Support",
    href: "mailto:support@mukoko.com",
    text: "support@mukoko.com",
  },
  { label: "Legal", href: "mailto:legal@nyuchi.com", text: "legal@nyuchi.com" },
  {
    label: "Twitter",
    href: "https://twitter.com/mukokoafrica",
    text: "@mukokoafrica",
    external: true,
  },
  {
    label: "Instagram",
    href: "https://instagram.com/mukoko.africa",
    text: "@mukoko.africa",
    external: true,
  },
];

export default function AboutPage() {
  return (
    <>
      <PageShell>
        <h1 className="elephant">About mukoko weather</h1>

        <section className="mt-8 space-y-4 text-text-secondary leading-relaxed">
          <p>
            <strong className="text-text-primary">mukoko weather</strong> is an
            AI-powered global weather intelligence platform. We provide
            accurate, real-time forecasts and actionable weather insights for
            farming, mining, travel, and daily life across Africa, Asia, the
            Middle East, South &amp; Central America, Eastern Europe, and
            beyond.
          </p>
          <p>
            Our mission is simple: <em>weather as a public good</em>. Everyone
            deserves access to reliable, contextual weather information —
            whether you&apos;re a farmer watching for frost, a traveller
            planning a safari, or a family in Manila planning the week ahead.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="eland">Who we are</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <p>
              <strong className="text-text-primary">mukoko weather</strong> is a
              product of{" "}
              <strong className="text-text-primary">Mukoko Africa</strong>, a
              division of{" "}
              <a href="https://nyuchi.com" className="sunbird" rel="noopener">
                Nyuchi Africa (PVT) Ltd
              </a>
              .
            </p>
            <p>
              The platform is developed and maintained by{" "}
              <strong className="text-text-primary">Nyuchi Web Services</strong>
              , the technology arm of Nyuchi Africa, building digital products
              that serve communities worldwide.
            </p>
            <p>
              <strong className="text-text-primary">Proudly Zimbabwean</strong>{" "}
              — designed, built, and operated from Zimbabwe. mukoko weather is
              African technology serving the world, proving that world-class
              software can come from anywhere.
            </p>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="eland">What we offer</h2>
          <ul className="mt-4 space-y-2 text-text-secondary">
            {OFFERINGS.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span
                  className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary"
                  aria-hidden="true"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="eland">Data sources</h2>
          <div className="mt-4 space-y-4 text-text-secondary leading-relaxed">
            <p>
              Weather data is sourced from{" "}
              <a
                href="https://www.tomorrow.io"
                className="sunbird"
                rel="noopener noreferrer"
              >
                Tomorrow.io
              </a>{" "}
              (primary) and{" "}
              <a
                href="https://open-meteo.com"
                className="sunbird"
                rel="noopener noreferrer"
              >
                Open-Meteo
              </a>{" "}
              (fallback). AI-powered summaries are generated using{" "}
              <a
                href="https://developers.cloudflare.com/workers-ai/"
                className="sunbird"
                rel="noopener noreferrer"
              >
                GLM on Cloudflare Workers AI
              </a>
              .
            </p>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="eland">Contact us</h2>
          <dl className="mt-4 space-y-3 text-base">
            {CONTACTS.map((c) => (
              <InfoRow
                key={c.label}
                label={c.label}
                value={
                  <a
                    href={c.href}
                    className="sunbird"
                    {...(c.external ? { rel: "noopener noreferrer" } : {})}
                  >
                    {c.text}
                  </a>
                }
              />
            ))}
          </dl>
        </section>

        <nav className="mt-10 flex gap-4 text-base" aria-label="Legal pages">
          <Link href="/privacy" className="sunbird">
            Privacy Policy
          </Link>
          <Link href="/terms" className="sunbird">
            Terms of Service
          </Link>
        </nav>
      </PageShell>
    </>
  );
}
