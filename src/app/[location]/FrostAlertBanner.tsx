import type { FrostAlert } from "@/lib/weather";

export function FrostAlertBanner({ alert }: { alert: FrostAlert }) {
  const bgColor =
    alert.risk === "severe"
      ? "bg-frost-severe-bg border-frost-severe"
      : alert.risk === "high"
        ? "bg-frost-high-bg border-earth"
        : "bg-frost-moderate-bg border-accent";

  const textColor =
    alert.risk === "severe"
      ? "text-frost-severe"
      : alert.risk === "high"
        ? "text-earth"
        : "text-accent";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`mb-6 rounded-[var(--radius-card)] border-l-4 p-4 ${bgColor}`}
    >
      <p className={`text-sm font-semibold ${textColor}`}>
        Frost {alert.risk === "severe" ? "Warning" : "Advisory"} — {alert.risk.toUpperCase()}
      </p>
      <p className={`mt-1 text-sm ${textColor}`}>{alert.message}</p>
    </div>
  );
}
