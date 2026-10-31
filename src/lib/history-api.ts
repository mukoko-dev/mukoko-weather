/**
 * The history API as the app asks for it (`GET /v1/history` on the Worker,
 * #268): the ranges the page offers, the query it builds, the sources a day can
 * come from and the credit each archive needs.
 *
 * The Worker reads what we recorded and stored first and pulls ONLY the missing
 * past dates from an external archive (NASA POWER, then Open-Meteo's ERA5), so
 * a view of any place on Earth has history. Pure helpers, no I/O.
 */

/** Widest range one request may ask for (about ten years). */
export const HISTORY_MAX_DAYS = 3660;

/** The periods the history page offers, in days. */
export const HISTORY_RANGES = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "3 months" },
  { value: 180, label: "6 months" },
  { value: 365, label: "1 year" },
  { value: 730, label: "2 years" },
  { value: 1825, label: "5 years" },
] as const;

export type HistoryDays = (typeof HISTORY_RANGES)[number]["value"];

/** Where a stored day came from. `recorded` is our own live record. */
export type HistorySource = "recorded" | "nasa-power" | "open-meteo-archive";

/** The archive providers: days from them are daily means of a reanalysis. */
export const ARCHIVE_SOURCES: readonly HistorySource[] = [
  "nasa-power",
  "open-meteo-archive",
];

export function historySource(value: unknown): HistorySource {
  return value === "nasa-power" || value === "open-meteo-archive"
    ? value
    : "recorded";
}

export function isArchiveSource(value: unknown): boolean {
  return historySource(value) !== "recorded";
}

/** One credit the response asks us to show (`sources` on the answer). */
export interface HistorySourceCredit {
  id: string;
  name: string;
  attribution: string;
  url: string;
  licence: string;
  licenceUrl?: string | null;
}

/** The parts of a `/v1/history` answer the page reads. */
export interface HistoryAnswer {
  data: unknown[];
  sources: HistorySourceCredit[];
  backfilled: number;
  clamped: boolean;
  /** Dates in the range still without a day (an archive lags a few days). */
  missing: number;
  /** True when fetched days are being stored after this answer. */
  saving: boolean;
  /**
   * True when the answer holds only part of the range for a reason that is NOT
   * the archive's plain lag: a store could not be read, a budget or a provider
   * was out, or a per-request cap was reached. A retry may complete it.
   */
  degraded: boolean;
}

function credit(v: unknown): HistorySourceCredit | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  if (
    typeof c.id !== "string" ||
    typeof c.name !== "string" ||
    typeof c.attribution !== "string" ||
    typeof c.url !== "string" ||
    typeof c.licence !== "string"
  ) {
    return null;
  }
  return {
    id: c.id,
    name: c.name,
    attribution: c.attribution,
    url: c.url,
    licence: c.licence,
    licenceUrl: typeof c.licenceUrl === "string" ? c.licenceUrl : null,
  };
}

/** Read a `/v1/history` body, tolerating older shapes (only `data`). */
export function readHistoryAnswer(json: unknown): HistoryAnswer {
  const b =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>)
      : {};
  const sources = Array.isArray(b.sources)
    ? b.sources.flatMap((s) => {
        const c = credit(s);
        return c ? [c] : [];
      })
    : [];
  return {
    data: Array.isArray(b.data) ? b.data : [],
    sources,
    backfilled: typeof b.backfilled === "number" ? b.backfilled : 0,
    clamped: b.clamped === true,
    missing: typeof b.missing === "number" ? b.missing : 0,
    saving: b.saving === true,
    degraded: b.degraded === true,
  };
}

/**
 * Only a short range is retried: it is nearly always served from what we hold,
 * so a retry after a network error or a 5xx is cheap. A longer one is a slow
 * fetch from an archive, and a retry would double a wait that is already long
 * (a 1-year view would otherwise wait up to 60 s).
 */
export const RETRY_UP_TO_DAYS = 31;

/**
 * How long to wait for a history answer. A cold view reads two stores, asks an
 * archive for the missing years and (in the background) stores them, so it can
 * take far longer than a cached one; the Worker's default 8 s would abort it
 * mid-run. Only a short range is retried (see RETRY_UP_TO_DAYS): for a long one
 * the Worker keeps filling after the client gives up, and the next view is
 * served from what it stored.
 */
export function historyFetchOptions(days: number): {
  timeoutMs: number;
  retries: number;
} {
  if (days <= RETRY_UP_TO_DAYS) return { timeoutMs: 20_000, retries: 1 };
  if (days <= 365) return { timeoutMs: 30_000, retries: 0 };
  return { timeoutMs: 45_000, retries: 0 };
}

/** After this long a view says it is still working (see STILL_WORKING_NOTE). */
export const STILL_WORKING_AFTER_MS = 10_000;

export const STILL_WORKING_NOTE =
  "Still working: days we have not stored yet are being fetched from the climate archives. A long range can take half a minute the first time.";

export interface HistoryQuery {
  slug: string;
  /** Sent too so a place the Worker cannot name still has history. */
  lat?: number | null;
  lon?: number | null;
  days?: number;
  /** YYYY-MM-DD, inclusive; wins over `days`. */
  start?: string;
  end?: string;
}

/** The query string for `GET /v1/history` (no leading `?`). */
export function historyQuery(q: HistoryQuery): string {
  const p = new URLSearchParams();
  p.set("location", q.slug);
  if (typeof q.lat === "number" && typeof q.lon === "number") {
    p.set("lat", String(Math.round(q.lat * 1000) / 1000));
    p.set("lon", String(Math.round(q.lon * 1000) / 1000));
  }
  if (q.start) {
    p.set("start", q.start);
    if (q.end) p.set("end", q.end);
  } else if (q.days !== undefined) {
    p.set(
      "days",
      String(Math.min(Math.max(1, Math.trunc(q.days)), HISTORY_MAX_DAYS)),
    );
  }
  return p.toString();
}

/**
 * One line about where the archive days came from, for the summary. `null`
 * when every day was recorded live.
 */
export function archiveNote(
  records: readonly { source: string }[],
): string | null {
  const archive = records.filter((r) => isArchiveSource(r.source)).length;
  if (archive === 0) return null;
  const power = records.some((r) => r.source === "nasa-power");
  const era5 = records.some((r) => r.source === "open-meteo-archive");
  const from =
    power && era5
      ? "NASA POWER and the Open-Meteo ERA5 archive"
      : power
        ? "NASA POWER"
        : "the Open-Meteo ERA5 archive";
  return `${archive} of ${records.length} days come from ${from} (reanalysis, daily averages). The rest were recorded live.`;
}

/** Shown when a place without a catalogue entry was asked for more than a year. */
export const CLAMPED_NOTE =
  "This place is not in our catalogue, so history is limited to the most recent year.";

/**
 * Shown when some dates in the range have no day yet BECAUSE the archives run
 * a few days behind. Not for a degraded answer: there the missing dates have a
 * different cause (see DEGRADED_NOTE), and blaming the archive would be wrong.
 */
export function lagNote(missing: number): string | null {
  if (missing <= 0) return null;
  return missing === 1
    ? "One day has no data yet: archives run a few days behind."
    : `${missing} days have no data yet: archives run a few days behind.`;
}

/** Shown when the answer is incomplete for a reason other than the archive lag. */
export const DEGRADED_NOTE =
  "Some history could not be loaded just now, so this may be incomplete. Try again in a moment.";

/** Shown when the history request itself failed. */
export const HISTORY_FAILED_NOTE = "History could not be loaded just now.";

/** A quiet note: the fetched days are being stored after the answer. */
export const SAVING_NOTE =
  "New days are being saved, so the next view will be faster.";

/**
 * The notes under the summary, from one answer. A degraded answer carries
 * none of the lag or saving notes (its missing dates are not the archive's
 * lag); the page shows DEGRADED_NOTE with a retry instead.
 */
export function historyNotices(
  answer: Pick<HistoryAnswer, "clamped" | "degraded" | "missing" | "saving">,
): string[] {
  const notes: string[] = [];
  if (answer.clamped) notes.push(CLAMPED_NOTE);
  if (!answer.degraded) {
    const lag = lagNote(answer.missing);
    if (lag) notes.push(lag);
    if (answer.saving) notes.push(SAVING_NOTE);
  }
  return notes;
}
