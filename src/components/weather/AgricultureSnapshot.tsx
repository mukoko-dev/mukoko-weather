"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppStore } from "@/lib/store";
import { CropIcon, SparklesIcon } from "@/lib/weather-icons";
import {
  MOISTURE_LABELS,
  STATUS_LABELS,
  WINDOW_ORDER,
  WINDOW_TITLES,
  agricultureUrl,
  farmingActivities,
  formatBalance,
  formatGdd,
  formatMm,
  formatMoisture,
  formatTempC,
  isAgricultureReady,
  riskClass,
  statusClasses,
  type AgriAIResponse,
  type AgricultureResponse,
} from "@/lib/agriculture";
import type { WeatherLocation } from "@/lib/locations";
import type { AISummaryUser } from "./AISummary";
import { AgricultureSnapshotSkeleton } from "./SectionSkeleton";

/**
 * Agriculture snapshot card (location page).
 *
 * A glanceable farm-weather view from `/api/py/agriculture`: the day's
 * verdict, spray / plant / harvest / irrigate windows, rain, soil, water
 * balance, GDD, frost/heat risk and spray wind. The numbers are
 * deterministic. Signed-in users also get one AI line explaining them
 * (`/api/ai/agriculture`, mode "snapshot"); anonymous users get a sign-in
 * link. Failures and unavailable data render nothing.
 */

interface Props {
  location: Pick<
    WeatherLocation,
    "slug" | "name" | "lat" | "lon" | "country" | "elevation"
  >;
  user: AISummaryUser | null;
}

/** A finished request, keyed by what was asked so stale results never show. */
type Result<T> =
  | { key: string; ok: true; value: T }
  | { key: string; ok: false };

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

export function AgricultureSnapshot({ location, user }: Props) {
  const selected = useAppStore((s) => s.selectedActivities);
  const crops = useMemo(() => farmingActivities(selected), [selected]);
  const pathname = usePathname() ?? `/${location.slug}`;
  const url = agricultureUrl(location, crops);
  const [result, setResult] = useState<Result<AgricultureResponse> | null>(
    null,
  );
  const [ai, setAI] = useState<Result<string> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as AgricultureResponse;
      })
      .then((value) => setResult({ key: url, ok: true, value }))
      .catch((err: unknown) => {
        if (!isAbort(err)) setResult({ key: url, ok: false });
      });
    return () => controller.abort();
  }, [url]);

  const current = result?.key === url ? result : null;
  const data = current?.ok ? current.value : null;
  const ready = isAgricultureReady(data);
  const signedIn = user !== null;

  const aiBody = useMemo(
    () =>
      JSON.stringify({
        location: {
          slug: location.slug,
          name: location.name,
          country: location.country ?? "",
          elevation: location.elevation,
          lat: location.lat,
          lon: location.lon,
        },
        activities: crops,
        mode: "snapshot",
      }),
    [
      location.slug,
      location.name,
      location.country,
      location.elevation,
      location.lat,
      location.lon,
      crops,
    ],
  );

  useEffect(() => {
    if (!ready || !signedIn) return;
    const controller = new AbortController();
    fetch("/api/ai/agriculture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: aiBody,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as AgriAIResponse;
      })
      .then((json) => setAI({ key: aiBody, ok: true, value: json.text }))
      .catch((err: unknown) => {
        if (!isAbort(err)) setAI({ key: aiBody, ok: false });
      });
    return () => controller.abort();
  }, [ready, signedIn, aiBody]);

  const aiNow = ai?.key === aiBody ? ai : null;

  if (!current) return <AgricultureSnapshotSkeleton />;
  if (!isAgricultureReady(data)) return null;

  const verdict = data.verdict ?? "wait";
  const verdictTone = statusClasses(verdict);
  const { frost, heat } = data.risks ?? {};
  const risks = [frost, heat].filter((r): r is NonNullable<typeof r> =>
    Boolean(r && r.level !== "none"),
  );
  const signInHref = `/auth/signin?returnTo=${encodeURIComponent(pathname)}`;

  return (
    <section
      aria-labelledby="agri-snapshot-heading"
      className="baobab w-full space-y-4 border-l-[6px] border-l-mineral-malachite"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="dove flex items-center gap-1.5 uppercase tracking-wider">
            <span aria-hidden="true" className="text-mineral-malachite">
              <CropIcon size={14} />
            </span>
            Agriculture
          </p>
          <h2 id="agri-snapshot-heading" className="giraffe">
            {data.headline}
          </h2>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${verdictTone.soft} ${verdictTone.text}`}
        >
          {STATUS_LABELS[verdict]}
          <span className="sr-only"> overall for field work today</span>
        </span>
      </header>

      <ul
        aria-label="Farm work windows"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {WINDOW_ORDER.map((key) => {
          const w = data.windows[key];
          const tone = statusClasses(w.status);
          return (
            <li key={key} className="rounded-card bg-surface-dim p-3">
              <p className="dove flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`}
                />
                {WINDOW_TITLES[key]}
                <span className="sr-only">: {STATUS_LABELS[w.status]}</span>
              </p>
              <p className="mt-1 text-base font-medium text-text-primary">
                {w.label}
              </p>
            </li>
          );
        })}
      </ul>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric
          term="Rain 24 h / 7 d"
          value={`${formatMm(data.rain.next24hMm)} / ${formatMm(data.rain.next7dMm)}`}
        />
        <Metric
          term="Topsoil moisture"
          value={`${formatMoisture(data.soil?.moistureTopsoil)}${
            data.soil?.moistureBand
              ? ` · ${MOISTURE_LABELS[data.soil.moistureBand]}`
              : ""
          }`}
        />
        <Metric
          term="Soil at seed depth"
          value={formatTempC(data.soil?.temperatureSeedDepth)}
        />
        <Metric
          term="Water balance 7 d"
          value={formatBalance(data.waterBalance?.balanceNext7dMm)}
        />
        <Metric term="GDD past 30 d" value={formatGdd(data.gdd?.past30d)} />
        <Metric
          term="Spray wind"
          value={
            data.wind?.speedKmh != null
              ? `${Math.round(data.wind.speedKmh)} km/h${data.wind.sprayable ? " · OK" : ""}`
              : "—"
          }
        />
      </dl>

      {risks.length > 0 && (
        <ul className="space-y-1">
          {risks.map((r) => (
            <li key={r.detail} className={`gazelle ${riskClass(r.level)}`}>
              {r.detail}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-start gap-2" aria-live="polite">
        <span aria-hidden="true" className="mt-1 text-mineral-malachite">
          <SparklesIcon size={14} />
        </span>
        {signedIn ? (
          aiNow?.ok ? (
            <p className="gazelle">{aiNow.value}</p>
          ) : !aiNow ? (
            <span
              role="status"
              aria-label="Loading Shamwari farm advice"
              className="mt-1 block h-4 w-3/4 animate-pulse rounded-full bg-text-tertiary/20"
            />
          ) : (
            <p className="dove">
              Shamwari&apos;s farm advice is unavailable right now.
            </p>
          )
        ) : (
          <p className="dove">
            <Link href={signInHref} prefetch={false} className="sunbird">
              Sign in
            </Link>{" "}
            for Shamwari&apos;s farm advice for {location.name}.
          </p>
        )}
      </div>

      <Link
        href={`/${location.slug}/agriculture`}
        className="sunbird inline-flex min-h-[var(--touch-target-min)] items-center"
      >
        Full agriculture insights →
      </Link>
    </section>
  );
}

function Metric({ term, value }: { term: string; value: string }) {
  return (
    <div className="rounded-card bg-surface-dim p-3">
      <dt className="dove">{term}</dt>
      <dd className="text-base font-medium text-text-primary">{value}</dd>
    </div>
  );
}
