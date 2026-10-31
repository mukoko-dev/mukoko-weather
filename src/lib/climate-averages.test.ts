import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_RECENT_DAYS,
  daysInMonthOf,
  forecastComparison,
  monthIndexOf,
  monthlyRows,
  parseMonthlyNormals,
  recentComparison,
  recentDaysFromHistory,
  type MonthlyNormal,
  type RecentDay,
} from "./climate-averages";
import type { DailyWeather } from "./weather";

function months(over: Partial<MonthlyNormal> = {}): MonthlyNormal[] {
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    meanTempC: 20,
    meanHighC: 28,
    meanLowC: 14,
    precipMm: 62, // 2 mm a day in a 31-day month
    rainyDays: 8,
    ...over,
  }));
}

const body = (m: unknown[]) => ({
  available: true,
  months: m,
  period: "1991–2020",
  source: "ERA5 via Open-Meteo",
});

function daily(
  highs: (number | null)[],
  rain: (number | null)[],
  start = "2026-10-08",
): DailyWeather {
  const t = highs.map((_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  return {
    time: t,
    temperature_2m_max: highs,
    precipitation_sum: rain,
  } as unknown as DailyWeather;
}

describe("parseMonthlyNormals", () => {
  it("accepts twelve months and keeps null as null", () => {
    const raw = months().map((m) => ({ ...m }));
    raw[0].precipMm = null as unknown as number;
    const parsed = parseMonthlyNormals(body(raw));
    expect(parsed?.months).toHaveLength(12);
    expect(parsed?.months[0].precipMm).toBeNull();
    expect(parsed?.months[0].meanHighC).toBe(28);
    expect(parsed?.period).toBe("1991–2020");
  });

  it("rejects an unavailable, short or malformed answer", () => {
    expect(parseMonthlyNormals(null)).toBeNull();
    expect(parseMonthlyNormals({ available: false, months: [] })).toBeNull();
    expect(parseMonthlyNormals(body(months().slice(0, 11)))).toBeNull();
    expect(parseMonthlyNormals(body([...months().slice(0, 11), 5]))).toBeNull();
  });

  it("never turns a missing value into zero", () => {
    const raw = months().map(() => ({ meanHighC: "x" }));
    const parsed = parseMonthlyNormals(body(raw));
    expect(parsed?.months.every((m) => m.meanHighC === null)).toBe(true);
  });
});

describe("dates", () => {
  it("reads the month and its length", () => {
    expect(monthIndexOf("2026-10-08")).toBe(9);
    expect(monthIndexOf("2026-13-01")).toBeNull();
    expect(monthIndexOf(undefined)).toBeNull();
    expect(daysInMonthOf("2026-02-10")).toBe(28);
    expect(daysInMonthOf("2024-02-10")).toBe(29);
    expect(daysInMonthOf("2026-10-31")).toBe(31);
  });

  it("labels the rows January first", () => {
    const rows = monthlyRows(months());
    expect(rows[0].label).toBe("Jan");
    expect(rows[11].label).toBe("Dec");
  });
});

describe("forecastComparison", () => {
  it("compares the week's highs with the month's normal high", () => {
    const c = forecastComparison(
      daily([32, 32, 32, 32, 32, 32, 32], [0, 0, 0, 0, 0, 0, 0]),
      months(),
      "temperature",
    );
    expect(c.basis).toBe("Next 7 days");
    expect(c.value).toBe(32);
    expect(c.normal).toBe(28);
    expect(c.delta).toBe(4);
    expect(c.sentence).toContain("4° above average");
  });

  it("prorates the month's rainfall to the days compared", () => {
    const c = forecastComparison(
      daily([30, 30, 30], [0, 0, 0]),
      months(),
      "precipitation",
    );
    // 62 mm over 31 days is 2 mm a day, so 6 mm over three days.
    expect(c.normal).toBe(6);
    expect(c.value).toBe(0);
    expect(c.sentence).toContain("Drier than average");
  });

  it("calls a close value close, and wetter wetter", () => {
    expect(
      forecastComparison(daily([28, 28], [4, 0]), months(), "precipitation")
        .sentence,
    ).toContain("Close to the average");
    expect(
      forecastComparison(daily([28, 28], [20, 5]), months(), "precipitation")
        .sentence,
    ).toContain("Wetter than average");
    expect(
      forecastComparison(daily([28, 28], [0, 0]), months(), "temperature")
        .sentence,
    ).toContain("Close to the average");
  });

  it("makes no comparison when the average is missing", () => {
    const c = forecastComparison(
      daily([30], [1]),
      months({ meanHighC: null, precipMm: null }),
      "temperature",
    );
    expect(c.delta).toBeNull();
    expect(c.sentence).toContain("no average is available");
    expect(
      forecastComparison(
        daily([30], [1]),
        months({ precipMm: null }),
        "precipitation",
      ).delta,
    ).toBeNull();
  });

  it("is safe on an empty forecast", () => {
    const c = forecastComparison(undefined, months(), "temperature");
    expect(c.value).toBeNull();
    expect(c.sentence).toContain("no average");
  });
});

describe("recentComparison", () => {
  const days = (n: number, high: number, rain: number): RecentDay[] =>
    Array.from({ length: n }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      highC: high,
      precipMm: rain,
    }));

  it("needs a week of record before it says anything", () => {
    expect(
      recentComparison(
        days(MIN_RECENT_DAYS - 1, 30, 0),
        months(),
        "temperature",
      ),
    ).toBeNull();
    expect(
      recentComparison(days(MIN_RECENT_DAYS, 30, 0), months(), "temperature"),
    ).not.toBeNull();
  });

  it("compares recorded highs and rain with the same month", () => {
    const t = recentComparison(days(10, 30, 0), months(), "temperature");
    expect(t?.basis).toBe("Last 10 recorded days");
    expect(t?.delta).toBe(2);
    const p = recentComparison(days(10, 30, 0), months(), "precipitation");
    expect(p?.normal).toBe(20);
    expect(p?.sentence).toContain("Drier than average");
  });
});

describe("recentDaysFromHistory", () => {
  it("reads only the daily block, oldest first, skipping bad docs", () => {
    const out = recentDaysFromHistory({
      data: [
        {
          date: "2026-10-03",
          daily: { temperature_2m_max: [31], precipitation_sum: [2] },
        },
        {
          date: "2026-10-01",
          daily: { temperature_2m_max: [29] },
          current: { precipitation: 9 },
        },
        { daily: { temperature_2m_max: [1] } },
        null,
        { date: "bad" },
      ],
    });
    expect(out.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-03"]);
    // A document's `current` is one moment, never the day's total.
    expect(out[0].precipMm).toBeNull();
    expect(out[1].precipMm).toBe(2);
    expect(recentDaysFromHistory(null)).toEqual([]);
  });
});

describe("the Averages detail calls only the Worker", () => {
  const root = resolve(__dirname, "../..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf-8");
  const hook = read("src/lib/use-climate-averages.ts");
  const view = read("src/components/weather/AveragesDetail.tsx");

  it("uses fetchWorker, never /api/py", () => {
    expect(hook).toContain('"normals/monthly"');
    expect(hook).toContain("fetchWorker(");
    expect(hook).not.toContain("/api/py");
    expect(read("src/lib/weather-api.ts")).toContain('| "normals/monthly"');
  });

  it("has temperature and precipitation tabs, a chart and a table alternative", () => {
    expect(view).toContain('<TabsTrigger value="temperature">');
    expect(view).toContain('<TabsTrigger value="precipitation">');
    expect(view).toContain("<MonthlyNormalsChart");
    expect(view).toContain("<table");
    expect(view).toContain("<caption");
    expect(view).toContain("ChartErrorBoundary");
    expect(view).toContain("unavailable for this place right now");
    expect(view).not.toMatch(/style=\{\{/);
  });

  it("is mounted by the modal only for the averages tile", () => {
    const modal = read("src/components/weather/MetricDetailModal.tsx");
    expect(modal).toContain('kind === "averages"');
    expect(modal).toContain("<AveragesDetail");
  });
});
