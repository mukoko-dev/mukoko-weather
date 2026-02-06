import type { FrostAlert } from "@/lib/weather";

export function FrostAlertBanner({ alert }: { alert: FrostAlert }) {
  const bgColor =
    alert.risk === "severe"
      ? "bg-red-900/10 border-red-600"
      : alert.risk === "high"
        ? "bg-orange-900/10 border-orange-500"
        : "bg-yellow-900/10 border-yellow-500";

  const textColor =
    alert.risk === "severe"
      ? "text-red-700 dark:text-red-300"
      : alert.risk === "high"
        ? "text-orange-700 dark:text-orange-300"
        : "text-yellow-700 dark:text-yellow-300";

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
