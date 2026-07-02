import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "Embed Weather Widgets",
  description:
    "Add mukoko weather widgets to your website. Four widget types — current condition, today card, 5-day and 7-day forecast cards — for any location worldwide, or the visitor's own location automatically.",
  alternates: {
    canonical: "https://weather.mukoko.com/embed",
  },
};

export default function EmbedPage() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-10 pb-24 sm:pb-10 sm:px-6 md:px-8">
        <h1 className="font-display text-3xl font-bold text-text-primary">
          Embed Weather Widgets
        </h1>
        <p className="mt-4 text-text-secondary">
          Add live weather to any React or Next.js site — all free, no API key
          required. Four widget types are available. Omit the{" "}
          <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
            location
          </code>{" "}
          prop and the widget automatically shows the visitor&apos;s local
          weather (detected from their IP).
        </p>

        {/* Install */}
        <section className="mt-10">
          <h2 className="eagle">Install</h2>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`import { MukokoWeatherEmbed } from "@mukoko/weather-embed";`}</code>
            </pre>
          </div>
        </section>

        {/* 1. Current condition */}
        <section className="mt-10">
          <h2 className="eagle">1 · Current condition</h2>
          <p className="mt-2 text-base text-text-secondary">
            A compact inline card — current temperature, condition, and an icon.
            Great for navbars, headers, or sidebars.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`{/* A specific location */}
<MukokoWeatherEmbed type="current" location="harare" />

{/* The visitor's own location (IP-based) */}
<MukokoWeatherEmbed type="current" />`}</code>
            </pre>
          </div>
        </section>

        {/* 2. Today card */}
        <section className="mt-10">
          <h2 className="eagle">2 · Today card</h2>
          <p className="mt-2 text-base text-text-secondary">
            A fuller current-day card — temperature, condition, feels-like, and
            today&apos;s high / low.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`<MukokoWeatherEmbed type="today" location="bulawayo" />`}</code>
            </pre>
          </div>
        </section>

        {/* 3. 5-day card */}
        <section className="mt-10">
          <h2 className="eagle">3 · 5-day card</h2>
          <p className="mt-2 text-base text-text-secondary">
            A five-day forecast strip — day, condition, and high / low per day.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`<MukokoWeatherEmbed type="5day" location="victoria-falls" />`}</code>
            </pre>
          </div>
        </section>

        {/* 4. 7-day card */}
        <section className="mt-10">
          <h2 className="eagle">4 · 7-day card</h2>
          <p className="mt-2 text-base text-text-secondary">
            A seven-day forecast strip — same layout as the 5-day card, extended
            to a full week.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`<MukokoWeatherEmbed type="7day" location="mutare" />`}</code>
            </pre>
          </div>
        </section>

        {/* Props */}
        <section className="mt-10">
          <h2 className="eagle">Props</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="border-b border-text-tertiary/10 text-left">
                  <th className="pb-2 pr-4 font-semibold text-text-primary">Prop</th>
                  <th className="pb-2 pr-4 font-semibold text-text-primary">Values</th>
                  <th className="pb-2 font-semibold text-text-primary">Description</th>
                </tr>
              </thead>
              <tbody className="text-text-secondary">
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">type</td>
                  <td className="py-2 pr-4">current, today, 5day, 7day</td>
                  <td className="py-2">Widget variant (default: current)</td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">location</td>
                  <td className="py-2 pr-4">harare, bulawayo, ...</td>
                  <td className="py-2">Location slug. Omit for the visitor&apos;s IP location</td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">lat / lon</td>
                  <td className="py-2 pr-4">numbers</td>
                  <td className="py-2">Explicit coordinates (override slug + IP)</td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">theme</td>
                  <td className="py-2 pr-4">light, dark, auto</td>
                  <td className="py-2">Theme (default: auto)</td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">apiUrl</td>
                  <td className="py-2 pr-4">URL</td>
                  <td className="py-2">API origin (default: weather.mukoko.com)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Public API */}
        <section className="mt-10 mb-10">
          <h2 className="eagle">Public API</h2>
          <p className="mt-2 text-base text-text-secondary">
            The widget is powered by a public JSON endpoint you can call directly
            from any site. With no parameters it returns weather for the
            visitor&apos;s location (derived from their IP); pass{" "}
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
            </code>{" "}
            to pin a location. CORS is open to all origins.
          </p>
          <div className="mt-4 tortoise">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`# Visitor's local weather (IP-based)
GET https://weather.mukoko.com/api/embed/current

# A specific location
GET https://weather.mukoko.com/api/embed/current?slug=harare

# Explicit coordinates
GET https://weather.mukoko.com/api/embed/current?lat=-17.83&lon=31.05`}</code>
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
      </main>
      <Footer />
    </>
  );
}
