import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "Embed Weather Widgets",
  description:
    "Add mukoko weather widgets to your website. Current conditions, forecasts, and compact badges for any Zimbabwe location.",
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
          Add live Zimbabwe weather data to any website. Three widget types
          available — all free, no API key required.
        </p>

        {/* Current Conditions Widget */}
        <section className="mt-10">
          <h2 className="text-xl font-semibold text-text-primary">
            Current Conditions
          </h2>
          <p className="mt-2 text-base text-text-secondary">
            A card showing live temperature, conditions, humidity, wind, and UV
            for any Zimbabwe location.
          </p>
          <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] bg-surface-card p-4">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`<!-- Current conditions for Harare -->
<div data-mukoko-widget="current"
     data-location="harare">
</div>
<script src="https://weather.mukoko.com/embed/widget.js" async></script>`}</code>
            </pre>
          </div>
        </section>

        {/* Forecast Widget */}
        <section className="mt-10">
          <h2 className="text-xl font-semibold text-text-primary">
            Forecast
          </h2>
          <p className="mt-2 text-base text-text-secondary">
            A multi-day forecast strip. Configure 3, 5, or 7 days.
          </p>
          <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] bg-surface-card p-4">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`<!-- 5-day forecast for Bulawayo -->
<div data-mukoko-widget="forecast"
     data-location="bulawayo"
     data-days="5">
</div>
<script src="https://weather.mukoko.com/embed/widget.js" async></script>`}</code>
            </pre>
          </div>
        </section>

        {/* Badge Widget */}
        <section className="mt-10">
          <h2 className="text-xl font-semibold text-text-primary">
            Compact Badge
          </h2>
          <p className="mt-2 text-base text-text-secondary">
            An inline badge that fits in navbars, headers, or sidebars. Shows
            temperature and condition at a glance.
          </p>
          <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] bg-surface-card p-4">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`<!-- Compact badge for Mutare -->
<div data-mukoko-widget="badge"
     data-location="mutare">
</div>
<script src="https://weather.mukoko.com/embed/widget.js" async></script>`}</code>
            </pre>
          </div>
        </section>

        {/* iframe embed */}
        <section className="mt-10">
          <h2 className="text-xl font-semibold text-text-primary">
            iframe Embed
          </h2>
          <p className="mt-2 text-base text-text-secondary">
            For complete isolation, use an iframe. Useful for CMS platforms
            that don&apos;t allow custom scripts.
          </p>
          <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] bg-surface-card p-4">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`<iframe
  src="https://weather.mukoko.com/embed/iframe/harare?type=current&theme=auto"
  width="380"
  height="280"
  frameborder="0"
  title="Harare Weather"
></iframe>`}</code>
            </pre>
          </div>
        </section>

        {/* React/Next.js integration */}
        <section className="mt-10">
          <h2 className="text-xl font-semibold text-text-primary">
            React / Next.js
          </h2>
          <p className="mt-2 text-base text-text-secondary">
            For Nyuchi products and React apps, use the{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              MukokoWeatherEmbed
            </code>{" "}
            component directly.
          </p>
          <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] bg-surface-card p-4">
            <pre className="overflow-x-auto text-base">
              <code className="font-mono text-text-primary">{`import { MukokoWeatherEmbed } from "@mukoko/weather-embed";

// Current conditions
<MukokoWeatherEmbed location="harare" type="current" />

// Forecast
<MukokoWeatherEmbed location="victoria-falls" type="forecast" days={5} />

// Badge
<MukokoWeatherEmbed location="marondera" type="badge" />`}</code>
            </pre>
          </div>
        </section>

        {/* Configuration options */}
        <section className="mt-10">
          <h2 className="text-xl font-semibold text-text-primary">
            Configuration
          </h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="border-b border-text-tertiary/10 text-left">
                  <th className="pb-2 pr-4 font-semibold text-text-primary">Attribute</th>
                  <th className="pb-2 pr-4 font-semibold text-text-primary">Values</th>
                  <th className="pb-2 font-semibold text-text-primary">Description</th>
                </tr>
              </thead>
              <tbody className="text-text-secondary">
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">data-mukoko-widget</td>
                  <td className="py-2 pr-4">current, forecast, badge</td>
                  <td className="py-2">Widget type (required)</td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">data-location</td>
                  <td className="py-2 pr-4">harare, bulawayo, ...</td>
                  <td className="py-2">Location slug (required)</td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">data-days</td>
                  <td className="py-2 pr-4">3, 5, 7</td>
                  <td className="py-2">Forecast days (default: 5)</td>
                </tr>
                <tr className="border-b border-text-tertiary/10">
                  <td className="py-2 pr-4 font-mono text-base">data-theme</td>
                  <td className="py-2 pr-4">light, dark, auto</td>
                  <td className="py-2">Theme (default: auto)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Available locations */}
        <section className="mt-10 mb-10">
          <h2 className="text-xl font-semibold text-text-primary">
            Available Locations
          </h2>
          <p className="mt-2 text-base text-text-secondary">
            265+ locations across the developing world. Use the slug value in{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              data-location
            </code>
            . Full list available at{" "}
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-base">
              GET /api/locations
            </code>
            .
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
