import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { MukokoWeatherEmbed } from "@/components/embed";

export const metadata: Metadata = {
  title: "Embed Weather Widgets",
  description:
    "Add mukoko weather widgets to any website in one line — copy-paste an <iframe>, or call the free public JSON API. Four widget types (current, today, 5-day, 7-day) for any location worldwide, or the visitor's own location automatically.",
  alternates: {
    canonical: "https://weather.mukoko.com/embed",
  },
};

const SITE = "https://weather.mukoko.com";

// Copy-paste iframe snippets — the primary, works-anywhere embed method.
const IFRAME_CURRENT = `<iframe
  src="${SITE}/embed/widget?type=current&location=harare"
  width="340" height="120" style="border:0" loading="lazy"
  title="mukoko weather — current conditions"></iframe>`;

const IFRAME_TODAY = `<iframe
  src="${SITE}/embed/widget?type=today&location=bulawayo"
  width="380" height="230" style="border:0" loading="lazy"
  title="mukoko weather — today"></iframe>`;

const IFRAME_5DAY = `<iframe
  src="${SITE}/embed/widget?type=5day&location=victoria-falls"
  width="460" height="300" style="border:0" loading="lazy"
  title="mukoko weather — 5-day forecast"></iframe>`;

const IFRAME_7DAY = `<iframe
  src="${SITE}/embed/widget?type=7day&location=mutare"
  width="460" height="380" style="border:0" loading="lazy"
  title="mukoko weather — 7-day forecast"></iframe>`;

const IFRAME_IP = `<!-- No location = the visitor's own weather (from their IP) -->
<iframe
  src="${SITE}/embed/widget?type=today"
  width="380" height="230" style="border:0" loading="lazy"
  title="mukoko weather — your location"></iframe>`;

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="mt-4 tortoise">
      <pre className="overflow-x-auto text-base">
        <code className="font-mono text-text-primary">{children}</code>
      </pre>
    </div>
  );
}

export default function EmbedPage() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-10 pb-24 sm:pb-10 sm:px-6 md:px-8">
        <h1 className="font-display text-3xl font-bold text-text-primary">
          Embed Weather Widgets
        </h1>
        <p className="mt-4 text-text-secondary">
          Add live weather to any website — no build step, no API key, all free.
          The fastest way is a copy-paste{" "}
          <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
            &lt;iframe&gt;
          </code>
          . Four widget types are available. Omit the{" "}
          <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
            location
          </code>{" "}
          parameter and the widget automatically shows the visitor&apos;s local
          weather (detected from their IP).
        </p>

        {/* 1 · iframe quick start */}
        <section className="mt-10">
          <h2 className="eagle">1 · Copy-paste iframe</h2>
          <p className="mt-2 text-base text-text-secondary">
            Works on any site — WordPress, Squarespace, plain HTML, or any
            framework. Paste the snippet where you want the widget to appear and
            adjust <code className="font-mono">width</code> /{" "}
            <code className="font-mono">height</code> to taste.
          </p>

          <h3 className="mt-6 giraffe">Current condition</h3>
          <p className="mt-1 text-base text-text-secondary">
            A compact inline card — current temperature, condition, and an icon.
          </p>
          <CodeBlock>{IFRAME_CURRENT}</CodeBlock>

          <h3 className="mt-6 giraffe">Today card</h3>
          <p className="mt-1 text-base text-text-secondary">
            A fuller current-day card — temperature, condition, feels-like, and
            today&apos;s high / low.
          </p>
          <CodeBlock>{IFRAME_TODAY}</CodeBlock>

          <h3 className="mt-6 giraffe">5-day forecast</h3>
          <p className="mt-1 text-base text-text-secondary">
            A five-day forecast strip — day, condition, and high / low per day.
          </p>
          <CodeBlock>{IFRAME_5DAY}</CodeBlock>

          <h3 className="mt-6 giraffe">7-day forecast</h3>
          <p className="mt-1 text-base text-text-secondary">
            The same layout as the 5-day card, extended to a full week.
          </p>
          <CodeBlock>{IFRAME_7DAY}</CodeBlock>

          <h3 className="mt-6 giraffe">Visitor&apos;s own location</h3>
          <p className="mt-1 text-base text-text-secondary">
            Drop the <code className="font-mono">location</code> parameter and
            the widget resolves the visitor&apos;s weather from their IP.
          </p>
          <CodeBlock>{IFRAME_IP}</CodeBlock>
        </section>

        {/* 2 · Live preview — proves it works with real data */}
        <section className="mt-10">
          <h2 className="eagle">2 · Live preview</h2>
          <p className="mt-2 text-base text-text-secondary">
            These are the real widgets, rendering live data from the public API
            right now. What you see below is exactly what your visitors get.
          </p>
          <div className="mt-4 flex flex-wrap items-start gap-6">
            <div>
              <p className="mb-2 dove">type=current · location=harare</p>
              <MukokoWeatherEmbed type="current" location="harare" />
            </div>
            <div>
              <p className="mb-2 dove">type=today · location=harare</p>
              <MukokoWeatherEmbed type="today" location="harare" />
            </div>
            <div>
              <p className="mb-2 dove">type=5day · location=harare</p>
              <MukokoWeatherEmbed type="5day" location="harare" />
            </div>
          </div>
        </section>

        {/* 3 · Widget URL parameters */}
        <section className="mt-10">
          <h2 className="eagle">3 · Widget URL parameters</h2>
          <p className="mt-2 text-base text-text-secondary">
            Configure the widget via query parameters on{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              {SITE}/embed/widget
            </code>
            .
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="border-b border-text-tertiary/10 text-left">
                  <th className="pb-2 pr-4 font-semibold text-text-primary">
                    Parameter
                  </th>
                  <th className="pb-2 pr-4 font-semibold text-text-primary">
                    Values
                  </th>
                  <th className="pb-2 font-semibold text-text-primary">
                    Description
                  </th>
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
                  <td className="py-2">
                    Location slug. Omit for the visitor&apos;s IP location
                  </td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">lat / lon</td>
                  <td className="py-2 pr-4">numbers</td>
                  <td className="py-2">
                    Explicit coordinates (override slug + IP)
                  </td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">theme</td>
                  <td className="py-2 pr-4">auto, light, dark</td>
                  <td className="py-2">Theme (default: auto)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* 4 · Public API */}
        <section className="mt-10">
          <h2 className="eagle">4 · Direct JSON API</h2>
          <p className="mt-2 text-base text-text-secondary">
            Prefer to build your own UI? The widget is powered by a public JSON
            endpoint you can call directly from any site or server. With no
            parameters it returns weather for the visitor&apos;s location
            (derived from their IP); pass{" "}
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
          <CodeBlock>{`# Visitor's local weather (IP-based)
curl ${SITE}/api/embed/current

# A specific location
curl "${SITE}/api/embed/current?slug=harare"

# Explicit coordinates
curl "${SITE}/api/embed/current?lat=-17.83&lon=31.05"`}</CodeBlock>
          <p className="mt-4 text-base text-text-secondary">Response shape:</p>
          <CodeBlock>{`{
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
                   "url": "${SITE}/harare" }
}`}</CodeBlock>
        </section>

        {/* npm package — clearly marked as not yet available */}
        <section className="mt-10 mb-10">
          <h2 className="eagle">React / npm package</h2>
          <p className="mt-2 text-base text-text-secondary">
            A published{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              @mukoko/weather-embed
            </code>{" "}
            React package is{" "}
            <strong className="text-text-primary">
              not yet available — coming soon
            </strong>
            . Until it ships, use the copy-paste{" "}
            <code className="font-mono">&lt;iframe&gt;</code> above (works in React
            and every other framework) or call the JSON API directly.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
