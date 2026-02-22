"use client";

import { useState, useEffect, useCallback } from "react";
import { StatusDot, StatusBadge, type ServiceStatus } from "@/components/ui/status-indicator";

interface CheckResult {
  name: string;
  status: ServiceStatus;
  latencyMs: number;
  message: string;
}

interface StatusResponse {
  status: "operational" | "degraded";
  timestamp: string;
  totalLatencyMs: number;
  checks: CheckResult[];
}

function OverallBanner({ status, timestamp }: { status: string; timestamp: string }) {
  const isOperational = status === "operational";

  return (
    <div
      className={`mt-6 flex items-center gap-3 rounded-[var(--radius-card)] border p-4 ${
        isOperational
          ? "border-severity-low/30 bg-severity-low/5"
          : "border-severity-moderate/30 bg-severity-moderate/5"
      }`}
    >
      <span
        className={`inline-flex h-4 w-4 rounded-full ${
          isOperational ? "bg-severity-low" : "bg-severity-moderate"
        }`}
        aria-hidden="true"
      />
      <div>
        <p className={`font-semibold ${isOperational ? "text-severity-low" : "text-severity-moderate"}`}>
          {isOperational ? "All systems operational" : "Some systems are experiencing issues"}
        </p>
        <p className="text-sm text-text-tertiary">
          Last checked: {new Date(timestamp).toLocaleString()}
        </p>
      </div>
    </div>
  );
}

export function StatusDashboard() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/status");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = await response.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();

    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (loading && !data) {
    return (
      <div className="mt-8 space-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-[var(--radius-card)] bg-surface-card"
          />
        ))}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="mt-8 rounded-[var(--radius-card)] border border-severity-severe/30 bg-severity-severe/5 p-6 text-center">
        <p className="font-semibold text-severity-severe">
          Unable to fetch status
        </p>
        <p className="mt-1 text-sm text-text-secondary">{error}</p>
        <button
          onClick={fetchStatus}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary/90"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div>
      <OverallBanner status={data.status} timestamp={data.timestamp} />

      <div className="mt-8 space-y-3">
        {data.checks.map((check) => (
          <div
            key={check.name}
            className="flex items-start gap-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm"
          >
            <div className="mt-1.5">
              <StatusDot status={check.status} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-text-primary">{check.name}</h3>
                <StatusBadge status={check.status} />
              </div>
              <p className="mt-0.5 text-sm text-text-secondary">{check.message}</p>
            </div>
            <div className="flex-shrink-0 text-right">
              <p className="text-sm font-medium text-text-tertiary">
                {check.latencyMs}ms
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between text-sm text-text-tertiary">
        <p>Total check time: {data.totalLatencyMs}ms</p>
        <button
          onClick={fetchStatus}
          disabled={loading}
          className="rounded-md bg-surface-card px-3 py-1.5 font-medium text-text-secondary shadow-sm transition-colors hover:bg-surface-card/80 disabled:opacity-50"
        >
          {loading ? "Checking..." : "Refresh"}
        </button>
      </div>

      <div className="mt-8 rounded-[var(--radius-card)] bg-surface-card p-4 text-sm text-text-secondary">
        <h3 className="font-semibold text-text-primary">About these checks</h3>
        <ul className="mt-2 space-y-1.5">
          <li>
            <strong className="text-text-primary">MongoDB Atlas</strong> — Database connectivity (weather cache, AI summaries, historical data)
          </li>
          <li>
            <strong className="text-text-primary">Tomorrow.io API</strong> — Primary weather data provider (realtime + forecast)
          </li>
          <li>
            <strong className="text-text-primary">Open-Meteo API</strong> — Fallback weather data provider (free, no auth)
          </li>
          <li>
            <strong className="text-text-primary">Anthropic AI</strong> — Shamwari AI weather summaries (Claude)
          </li>
          <li>
            <strong className="text-text-primary">Weather Cache</strong> — Active cached weather data (15-min TTL)
          </li>
          <li>
            <strong className="text-text-primary">AI Summary Cache</strong> — Active cached AI summaries (30-120 min tiered TTL)
          </li>
        </ul>
        <p className="mt-3 text-text-tertiary">
          Status auto-refreshes every 60 seconds. All checks run in parallel for minimum latency.
        </p>
      </div>
    </div>
  );
}
