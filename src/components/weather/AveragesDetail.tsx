"use client";

import { useMemo, useState } from "react";
import type { WeatherData } from "@/lib/weather";
import {
  forecastComparison,
  monthIndexOf,
  monthlyRows,
  recentComparison,
  type Comparison,
} from "@/lib/climate-averages";
import { useMonthlyNormals, useRecentDays } from "@/lib/use-climate-averages";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartSkeleton } from "@/components/ui/skeleton";
import { ChartErrorBoundary } from "./ChartErrorBoundary";
import { MonthlyNormalsChart } from "./charts/MonthlyNormalsChart";

type Tab = "temperature" | "precipitation";

interface Props {
  data: WeatherData;
  lat?: number;
  lon?: number;
  /** Location slug, for the recorded days (only some places have a history). */
  slug?: string;
}

function Sentences({ items }: { items: (Comparison | null)[] }) {
  const shown = items.filter((c): c is Comparison => c !== null);
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {shown.map((c) => (
        <li key={c.basis} className="gazelle">
          {c.sentence}
        </li>
      ))}
    </ul>
  );
}

/**
 * The Averages detail: temperature and precipitation tabs, the twelve monthly
 * normals as a chart and as a table (the chart's text alternative), and the
 * coming week and the recorded days set against them. Everything comes from
 * the Rust Worker; nothing is compared unless both sides exist.
 */
export function AveragesDetail({ data, lat, lon, slug }: Props) {
  const [tab, setTab] = useState<Tab>("temperature");
  const normals = useMonthlyNormals(lat, lon, true);
  const recent = useRecentDays(slug, true);

  const months = normals.status === "ready" ? normals.data.months : null;
  const rows = useMemo(() => (months ? monthlyRows(months) : []), [months]);
  const currentMonth = monthIndexOf(data.daily?.time?.[0]);

  const comparisons = useMemo(() => {
    if (!months) return null;
    const days = recent.status === "ready" ? recent.data : [];
    return {
      temperature: [
        forecastComparison(data.daily, months, "temperature"),
        recentComparison(days, months, "temperature"),
      ],
      precipitation: [
        forecastComparison(data.daily, months, "precipitation"),
        recentComparison(days, months, "precipitation"),
      ],
    };
  }, [months, data.daily, recent]);

  if (normals.status === "loading") return <ChartSkeleton />;
  if (normals.status === "unavailable" || !months || !comparisons) {
    return (
      <p role="status" className="dove">
        Monthly averages are unavailable for this place right now.
      </p>
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v === "precipitation" ? v : "temperature")}
      className="gap-[var(--space-stack)]"
    >
      <TabsList aria-label="Averages">
        <TabsTrigger value="temperature">Temperature</TabsTrigger>
        <TabsTrigger value="precipitation">Precipitation</TabsTrigger>
      </TabsList>

      {(["temperature", "precipitation"] as const).map((mode) => (
        <TabsContent
          key={mode}
          value={mode}
          className="flex flex-col gap-[var(--space-section)]"
        >
          <Sentences items={comparisons[mode]} />

          <section aria-label={`Monthly average ${mode}`}>
            <h3 className="giraffe mb-[var(--space-stack)]">
              Monthly averages
            </h3>
            <ChartErrorBoundary name={`${mode} averages chart`}>
              <MonthlyNormalsChart data={rows} mode={mode} />
            </ChartErrorBoundary>

            <table className="mt-[var(--space-stack)] w-full text-sm">
              <caption className="sr-only">
                Average {mode === "temperature" ? "high and low" : "rainfall"}{" "}
                by month, {normals.data.period}
              </caption>
              <thead>
                <tr className="text-left text-text-tertiary">
                  <th scope="col" className="py-1 font-medium">
                    Month
                  </th>
                  {mode === "temperature" ? (
                    <>
                      <th scope="col" className="py-1 font-medium">
                        High
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Low
                      </th>
                    </>
                  ) : (
                    <>
                      <th scope="col" className="py-1 font-medium">
                        Rain
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Rainy days
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.label}
                    aria-current={i === currentMonth ? "date" : undefined}
                    className={
                      i === currentMonth
                        ? "border-t border-border font-medium text-text-primary"
                        : "border-t border-border text-text-secondary"
                    }
                  >
                    <th scope="row" className="py-1.5 text-left font-medium">
                      {r.label}
                    </th>
                    {mode === "temperature" ? (
                      <>
                        <td>
                          {r.meanHighC === null
                            ? "–"
                            : `${Math.round(r.meanHighC)}°`}
                        </td>
                        <td>
                          {r.meanLowC === null
                            ? "–"
                            : `${Math.round(r.meanLowC)}°`}
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          {r.precipMm === null
                            ? "–"
                            : `${Math.round(r.precipMm)} mm`}
                        </td>
                        <td>
                          {r.rainyDays === null ? "–" : Math.round(r.rainyDays)}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <p className="dove">
            Averages for {normals.data.period}, {normals.data.source}. A dash
            means no average is available.
          </p>
        </TabsContent>
      ))}
    </Tabs>
  );
}
