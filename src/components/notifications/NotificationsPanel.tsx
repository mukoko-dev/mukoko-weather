"use client";

import type { ReactNode } from "react";
import {
  CloudLightning,
  Flame,
  Snowflake,
  Waves,
  type LucideIcon,
} from "lucide-react";
import type { Alert, AlertKind } from "@/lib/alerts";
import { ALERTS_INTRO, emptyAlertsCopy } from "@/lib/alerts";
import type { AlertSnapshot } from "@/lib/alerts-watch";
import { viewerOffsetSeconds } from "@/lib/location-time";

/** The kinds a person can report from the list, and the report type each opens. */
export type ReportableKind = Extract<AlertKind, "flooding" | "wildfire">;

const KIND_ICON: Record<AlertKind, LucideIcon> = {
  frost: Snowflake,
  lightning: CloudLightning,
  wildfire: Flame,
  flooding: Waves,
};

const REPORT_LABEL: Record<ReportableKind, string> = {
  flooding: "Report flooding",
  wildfire: "Report wildfire",
};

export interface NotificationsPanelViewProps {
  /** null while the first read is under way. */
  snapshot: AlertSnapshot | null;
  /**
   * The report buttons to offer: only kinds whose report type this build
   * knows, and only while reporting is on. Empty hides every button.
   */
  reportKinds: readonly ReportableKind[];
  /** The place a report from the empty state is for, or null (no buttons then). */
  reportPlace: string | null;
  onReport: (kind: ReportableKind, placeSlug: string | null) => void;
  onOpenSettings: () => void;
}

/**
 * The alerts list: a card for each alert, or an honest empty state. A store-free
 * view (the container passes everything in), so it renders and tests on its own.
 *
 * - `aria-live="polite"` on the region: an alert that appears while the list
 *   is open is announced, without stealing focus.
 * - Every alert shows what it is (Advisory or Community report), where, when
 *   it applies, what the data is as of (the forecast's time in the PLACE's
 *   zone), and its source.
 * - Controls are the shared pill buttons (`.impala-sm`, 49px tall).
 */
export function NotificationsPanelView({
  snapshot,
  reportKinds,
  reportPlace,
  onReport,
  onOpenSettings,
}: NotificationsPanelViewProps) {
  const reportButtons = (
    kinds: readonly ReportableKind[],
    placeSlug: string | null,
  ) =>
    kinds.length > 0 && placeSlug !== null ? (
      <div className="flex flex-wrap gap-[var(--gap-floor)]">
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => onReport(kind, placeSlug)}
            className="impala-sm"
          >
            {REPORT_LABEL[kind]}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-[var(--space-stack)]">
      <p className="dove">{ALERTS_INTRO}</p>

      <div
        aria-live="polite"
        className="flex flex-col gap-[var(--space-stack)]"
      >
        {snapshot === null ? (
          <p role="status" className="dove">
            Checking your places…
          </p>
        ) : snapshot.shown.length > 0 ? (
          <ul
            aria-label="Alerts for your places"
            className="flex flex-col gap-[var(--space-stack)]"
          >
            {snapshot.shown.map((alert) => (
              <li key={alert.id}>
                <AlertCard
                  alert={alert}
                  reportKind={
                    (alert.kind === "flooding" || alert.kind === "wildfire") &&
                    reportKinds.includes(alert.kind)
                      ? alert.kind
                      : null
                  }
                  onReport={onReport}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            snapshot={snapshot}
            reportButtons={reportButtons(reportKinds, reportPlace)}
          />
        )}
      </div>

      <div>
        <button type="button" onClick={onOpenSettings} className="impala-sm">
          Alert settings
        </button>
      </div>
    </div>
  );
}

function EmptyState({
  snapshot,
  reportButtons,
}: {
  snapshot: AlertSnapshot;
  reportButtons: ReactNode;
}) {
  const copy = emptyAlertsCopy(
    snapshot.result,
    snapshot.result.alerts.length - snapshot.shown.length,
    viewerOffsetSeconds(new Date(snapshot.at)),
  );
  return (
    <div className="acacia flex flex-col gap-[var(--space-stack)]">
      <div>
        <h3 className="giraffe">{copy.title}</h3>
        <p className="gazelle mt-1">{copy.detail}</p>
      </div>
      {reportButtons && (
        <div className="flex flex-col gap-[var(--gap-floor)]">
          <p className="dove">Seeing something? Tell your community.</p>
          {reportButtons}
        </div>
      )}
    </div>
  );
}

function AlertCard({
  alert,
  reportKind,
  onReport,
}: {
  alert: Alert;
  reportKind: ReportableKind | null;
  onReport: (kind: ReportableKind, placeSlug: string | null) => void;
}) {
  const Icon = KIND_ICON[alert.kind];
  const headingId = `alert-${alert.id.replace(/[^a-z0-9-]/gi, "-")}`;
  return (
    <article
      aria-labelledby={headingId}
      className="acacia flex flex-col gap-[var(--gap-floor)]"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-dim text-text-secondary"
          aria-hidden="true"
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="giraffe">
            {alert.headline}
          </h3>
          <p className="dove">{alert.placeName}</p>
        </div>
      </div>
      <p className="gazelle">{alert.message}</p>
      <dl className="dove flex flex-col gap-0.5">
        <div>
          <dt className="sr-only">When</dt>
          <dd>{alert.when}</dd>
        </div>
        <div>
          <dt className="sr-only">As of</dt>
          <dd>{alert.asOf}</dd>
        </div>
        <div>
          <dt className="sr-only">Source</dt>
          <dd>{alert.source}</dd>
        </div>
      </dl>
      {reportKind && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => onReport(reportKind, alert.placeSlug)}
            className="impala-sm"
          >
            {REPORT_LABEL[reportKind]}
          </button>
        </div>
      )}
    </article>
  );
}
