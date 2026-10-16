"use client";

import { useMemo, type ReactNode } from "react";
import { GDDChart } from "./charts/GDDChart";
import { RainEtChart } from "./charts/RainEtChart";
import { SoilMoistureChart } from "./charts/SoilMoistureChart";
import { SoilTemperatureChart } from "./charts/SoilTemperatureChart";
import { SprayWindowChart } from "./charts/SprayWindowChart";
import { WaterBalanceChart } from "./charts/WaterBalanceChart";
import {
  forecastChartRows,
  gddRows,
  hasSeries,
  type AgriDay,
} from "@/lib/agriculture";

/**
 * The agriculture page's chart stack (16-day forecast; GDD over the past
 * 30 days too). Orchestrates the chart components; renders a chart only when
 * its series carry data (soil moisture thins out after about 9 days).
 */

interface Props {
  daily: readonly AgriDay[];
}

interface ChartBlock {
  id: string;
  title: string;
  note: string;
  keys: string[];
  render: () => ReactNode;
}

export function AgricultureCharts({ daily }: Props) {
  const rows = useMemo(() => forecastChartRows(daily), [daily]);
  const gdd = useMemo(() => gddRows(daily), [daily]);

  const blocks: ChartBlock[] = [
    {
      id: "agri-rain-et",
      title: "Rain against crop water use",
      note: "Daily rain (bars) and reference evapotranspiration, ET₀ (line), in mm.",
      keys: ["rainMm", "et0Mm"],
      render: () => <RainEtChart data={rows} />,
    },
    {
      id: "agri-balance",
      title: "Water balance",
      note: "Rain minus ET₀ each day, and the running total. Below zero the crop draws down soil water.",
      keys: ["balanceMm"],
      render: () => <WaterBalanceChart data={rows} />,
    },
    {
      id: "agri-soil-moisture",
      title: "Soil moisture by depth",
      note: "Share of the soil volume holding water. Bands depend on soil texture, so read trends, not exact values.",
      keys: ["sm0to1", "sm3to9", "sm27to81"],
      render: () => <SoilMoistureChart data={rows} />,
    },
    {
      id: "agri-soil-temp",
      title: "Soil temperature by depth",
      note: "Daily means. Seed depth (6 cm) decides germination.",
      keys: ["st0", "st6", "st54"],
      render: () => <SoilTemperatureChart data={rows} />,
    },
    {
      id: "agri-spray",
      title: "Spray hours and leaf wetness",
      note: "Hours each day that are fit to spray, against hours the leaves stay wet (disease pressure).",
      keys: ["sprayHours", "leafWetHours"],
      render: () => <SprayWindowChart data={rows} />,
    },
  ];

  return (
    <div className="space-y-[var(--space-section)]">
      {blocks
        .filter((b) => hasSeries(rows, b.keys))
        .map((b) => (
          <section
            key={b.id}
            aria-labelledby={b.id}
            className="acacia space-y-3"
          >
            <h2 id={b.id} className="giraffe">
              {b.title}
            </h2>
            <p className="dove">{b.note}</p>
            {b.render()}
          </section>
        ))}
      {hasSeries(gdd, ["gddMaize"]) && (
        <section aria-labelledby="agri-gdd" className="acacia space-y-3">
          <h2 id="agri-gdd" className="giraffe">
            Growing degree days to date
          </h2>
          <p className="dove">
            Running total since 30 days ago (base 10 °C, cap 30 °C), through the
            forecast.
          </p>
          <GDDChart data={gdd} seriesKeys={["gddMaize"]} maxTicksLimit={8} />
        </section>
      )}
    </div>
  );
}
