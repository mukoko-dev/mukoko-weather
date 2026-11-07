"use client";

import type { ReactNode } from "react";
import { ALERT_KINDS, ALERT_KIND_ABOUT, ALERT_KIND_LABELS } from "@/lib/alerts";
import {
  COMING_SOON_CHANNELS,
  DELIVERY_BEST_EFFORT,
  IN_APP_DELIVERY,
  type PushRow,
} from "@/lib/notification-delivery";
import {
  QUIET_HOUR_CHOICES,
  quietEndPatch,
  quietModeOf,
  quietSwitchPatch,
  type NotificationPrefs,
} from "@/lib/notification-prefs";
import { ToggleRow } from "@/components/weather/ToggleRow";
import { trackEvent } from "@/lib/analytics";

export interface NotificationSettingsViewProps {
  prefs: NotificationPrefs;
  onChange: (patch: Partial<NotificationPrefs>) => void;
  push: { row: PushRow; busy: boolean; onAction: () => void };
  /** Back to the list; omit when the settings were opened on their own. */
  onBack?: () => void;
}

/**
 * The notification settings: which alerts, quiet hours, and how they reach the
 * person. A store-free view (the container wires the store and the push hook),
 * so it renders and tests on its own.
 *
 * Honest by construction: the push row is `pushRow()`'s answer and shows a
 * button only when there is something to do; Campfire is a plain "Coming
 * soon" row with no control.
 */
export function NotificationSettingsView({
  prefs,
  onChange,
  push,
  onBack,
}: NotificationSettingsViewProps) {
  const quietOn = quietModeOf(prefs) !== "off";
  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {onBack && (
        <div>
          <button type="button" onClick={onBack} className="impala-sm">
            Back to alerts
          </button>
        </div>
      )}

      <section
        aria-labelledby="ns-alerts-heading"
        className="flex flex-col gap-[var(--space-stack)]"
      >
        <div>
          <h3 id="ns-alerts-heading" className="giraffe">
            Alerts
          </h3>
          <p className="dove mt-1">
            Choose what to be told about at your places.
          </p>
        </div>
        <div className="flex flex-col gap-[var(--gap-floor)]">
          {ALERT_KINDS.map((kind) => (
            <ToggleRow
              key={kind}
              id={`alert-kind-${kind}`}
              label={ALERT_KIND_LABELS[kind]}
              description={ALERT_KIND_ABOUT[kind]}
              checked={prefs[kind]}
              onChange={(next) => {
                onChange({ [kind]: next });
                trackEvent("alert_kind_toggled", { kind, enabled: next });
              }}
            />
          ))}
        </div>
      </section>

      <section
        aria-labelledby="ns-quiet-heading"
        className="flex flex-col gap-[var(--space-stack)]"
      >
        <div>
          <h3 id="ns-quiet-heading" className="giraffe">
            Quiet hours
          </h3>
          <p className="dove mt-1">
            On this device&rsquo;s clock. Quiet hours pause the dot on the bell;
            the list still shows your alerts.
          </p>
        </div>
        <ToggleRow
          id="quiet-hours"
          label="Use quiet hours"
          description="Off unless you switch them on."
          checked={quietOn}
          onChange={(next) => onChange(quietSwitchPatch(next))}
        />
        {quietOn && (
          <div className="grid grid-cols-2 gap-[var(--gap-floor)]">
            <HourPicker
              id="quiet-from"
              label="From"
              value={prefs.quietStart as number}
              onPick={(hour) => onChange(quietEndPatch(prefs, "start", hour))}
            />
            <HourPicker
              id="quiet-to"
              label="To"
              value={prefs.quietEnd as number}
              onPick={(hour) => onChange(quietEndPatch(prefs, "end", hour))}
            />
          </div>
        )}
      </section>

      <section
        aria-labelledby="ns-delivery-heading"
        className="flex flex-col gap-[var(--space-stack)]"
      >
        <div>
          <h3 id="ns-delivery-heading" className="giraffe">
            Delivery
          </h3>
          <p className="dove mt-1">
            {DELIVERY_BEST_EFFORT} An alert can arrive late or not at all.
          </p>
        </div>
        <ul className="flex flex-col gap-[var(--gap-floor)]">
          <li>
            <DeliveryCard
              title={IN_APP_DELIVERY.title}
              state={IN_APP_DELIVERY.status}
              detail={IN_APP_DELIVERY.detail}
            />
          </li>
          <li>
            <DeliveryCard
              title={push.row.title}
              state={push.row.state}
              detail={push.row.detail}
              statusId={push.row.status}
            >
              {push.row.action && (
                <button
                  type="button"
                  onClick={push.onAction}
                  disabled={push.busy}
                  aria-busy={push.busy}
                  className={
                    push.row.action === "enable" ? "kudu-sm" : "impala-sm"
                  }
                >
                  {push.busy ? "Working…" : push.row.actionLabel}
                </button>
              )}
            </DeliveryCard>
          </li>
          {COMING_SOON_CHANNELS.map((channel) => (
            <li key={channel.id}>
              <DeliveryCard
                title={channel.title}
                state="Coming soon"
                detail={channel.detail}
              />
            </li>
          ))}
        </ul>
      </section>

      <p className="dove">Your choices are saved on this device.</p>
    </div>
  );
}

function DeliveryCard({
  title,
  state,
  detail,
  statusId,
  children,
}: {
  title: string;
  state: string;
  detail: string;
  /** Marks the state for tests and styling hooks. */
  statusId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="acacia flex flex-col gap-[var(--gap-floor)]"
      data-delivery-status={statusId}
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-base font-semibold text-text-primary">{title}</h4>
        <p className="shrink-0 text-sm text-text-secondary">{state}</p>
      </div>
      <p className="dove">{detail}</p>
      {children && <div className="pt-1">{children}</div>}
    </div>
  );
}

function HourPicker({
  id,
  label,
  value,
  onPick,
}: {
  id: string;
  label: string;
  value: number;
  onPick: (hour: number) => void;
}) {
  return (
    <div className="flex flex-col gap-[var(--gap-floor)]">
      <label htmlFor={id} className="text-base font-medium text-text-primary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onPick(Number(e.target.value))}
        className="crane min-h-[var(--touch-target-min)] px-[var(--inset-floor)]"
      >
        {QUIET_HOUR_CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}
