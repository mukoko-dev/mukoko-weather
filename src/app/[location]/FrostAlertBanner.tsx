import type { FrostAlert } from "@/lib/weather";

export function FrostAlertBanner({ alert }: { alert: FrostAlert }) {
  const bgColor =
    alert.risk === "severe"
      ? "bg-[rgba(179,38,30,0.1)] border-[#B3261E]"
      : alert.risk === "high"
        ? "bg-[rgba(139,69,19,0.1)] border-earth"
        : "bg-[rgba(93,64,55,0.1)] border-accent";

  const textColor =
    alert.risk === "severe"
      ? "text-[#B3261E] dark:text-[#FF5252]"
      : alert.risk === "high"
        ? "text-earth dark:text-earth"
        : "text-accent dark:text-accent";

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
