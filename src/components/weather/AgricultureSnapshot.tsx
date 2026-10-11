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
  type AgricultureResponse,
} from "@/lib/agriculture";
import type { WeatherLocation } from "@/lib/locations";
import { agriAIBody, fetchAgriAI, peekAgriAI } from "@/lib/agriculture-client";
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
  const openMyWeather = useAppStore((s) => s.openMyWeather);
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
  const signedIn = user !== null;
  // AI only for signed-in users who told us what they farm: an advice line
  // for crops nobody picked would spend a model call on nothing.
  const wantsAI = signedIn && crops.length > 0;
  const { slug, name, country, elevation, lat, lon } = location;
  const aiBody = useMemo(
    () =>
      agriAIBody(
        { slug, name, country, elevation, lat, lon },
        crops,
        "snapshot",
      ),
    [slug, name, country, elevation, lat, lon, crops],
  );

  // Started in parallel with the data fetch: the server rebuilds the data
  // itself, so waiting for the client copy would only add a round trip.
  useEffect(() => {
    if (!wantsAI || peekAgriAI(aiBody) !== undefined) return;
    let live = true;
    fetchAgriAI(aiBody)
      .then((text) => live && setAI({ key: aiBody, ok: true, value: text }))
      .catch(() => live && setAI({ key: aiBody, ok: false }));
    return () => {
      live = false;
    };
  }, [wantsAI, aiBody]);

  const cachedText = wantsAI ? peekAgriAI(aiBody) : undefined;
  const aiNow: Result<string> | null =
    cachedText !== undefined
      ? { key: aiBody, ok: true, value: cachedText }
      : ai?.key === aiBody
        ? ai
        : null;

  if (!current) return <AgricultureSnapshotSkeleton />;
  if (!isAgricultureReady(data)) return null;

  const verdict = data.verdict;
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
            <li key={key} className="meerkat">
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
              ? `${Math.round(data.wind.speedKmh)} km/h · ${
                  data.wind.sprayable ? "OK to spray" : "Not now"
                }`
              : "—"
          }
          tone={data.wind?.sprayable === false ? riskClass("high") : undefined}
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

      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-1 text-mineral-malachite">
          <SparklesIcon size={14} />
        </span>
        {signedIn && crops.length === 0 ? (
          <p className="dove">
            <button
              type="button"
              onClick={() => openMyWeather("activities")}
              className="sunbird dik-dik"
            >
              Pick your crops
            </button>{" "}
            for Shamwari&apos;s farm advice for {location.name}.
          </p>
        ) : signedIn ? (
          <div role="status" aria-live="polite" className="min-w-0 flex-1">
            {aiNow?.ok ? (
              <p className="gazelle">{aiNow.value}</p>
            ) : !aiNow ? (
              <>
                <span className="mt-1 block h-4 w-3/4 animate-pulse rounded-full bg-text-tertiary/20" />
                <span className="sr-only">Loading Shamwari farm advice</span>
              </>
            ) : (
              <p className="dove">
                Shamwari&apos;s farm advice is unavailable right now.
              </p>
            )}
          </div>
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

function Metric({
  term,
  value,
  tone,
}: {
  term: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="meerkat">
      <dt className="dove">{term}</dt>
      <dd className={`text-base font-medium ${tone ?? "text-text-primary"}`}>
        {value}
      </dd>
    </div>
  );
}
