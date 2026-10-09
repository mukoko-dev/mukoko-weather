"use client";

import { useState, useEffect, useCallback } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  StatusDot,
  StatusBadge,
  type ServiceStatus,
} from "@/components/ui/status-indicator";

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

function OverallBanner({
  status,
  timestamp,
}: {
  status: string;
  timestamp: string;
}) {
  const isOperational = status === "operational";

  return (
    <Alert
      variant={isOperational ? "success" : "warning"}
      role="status"
      className="mt-6 flex items-center gap-3"
    >
      <StatusDot
        status={isOperational ? "operational" : "degraded"}
        size="lg"
        aria-hidden="true"
      />
      <div>
        <AlertTitle
          className={
            isOperational ? "text-severity-low" : "text-severity-moderate"
          }
        >
          {isOperational
            ? "All systems operational"
            : "Some systems are experiencing issues"}
        </AlertTitle>
        <AlertDescription className="text-base text-text-tertiary">
          Last checked: {new Date(timestamp).toLocaleString()}
        </AlertDescription>
      </div>
    </Alert>
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
      const response = await fetch("/api/py/status");
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

    // Auto-refresh every 5 minutes. The server caches the payload for ~60s, so
    // spacing client polls well beyond that avoids piling requests on top of a
    // still-fresh cache while keeping the dashboard reasonably live.
    const interval = setInterval(fetchStatus, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (loading && !data) {
    return (
      <div className="mt-8 space-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="chameleon h-20" />
        ))}
      </div>
    );
  }

  if (error && !data) {
    return (
      <Alert variant="severe" className="mt-8 text-center">
        <AlertTitle>Unable to fetch status</AlertTitle>
        <AlertDescription className="text-base">{error}</AlertDescription>
        <button onClick={fetchStatus} className="kudu-sm mt-4">
          Retry
        </button>
      </Alert>
    );
  }

  if (!data) return null;

  return (
    <div>
      <OverallBanner status={data.status} timestamp={data.timestamp} />

      <div className="mt-8 space-y-3">
        {data.checks.map((check) => (
          <div key={check.name} className="pangolin flex items-start gap-3">
            <div className="mt-1.5">
              <StatusDot status={check.status} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-text-primary">
                  {check.name}
                </h3>
                <StatusBadge status={check.status} />
              </div>
              <p className="mt-0.5 text-base text-text-secondary">
                {check.message}
              </p>
            </div>
            <div className="flex-shrink-0 text-right">
              <p className="text-base font-medium text-text-tertiary">
                {check.latencyMs}ms
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between text-base text-text-tertiary">
        <p>Total check time: {data.totalLatencyMs}ms</p>
        <button onClick={fetchStatus} disabled={loading} className="impala-sm">
          {loading ? "Checking..." : "Refresh"}
        </button>
      </div>

      <div className="mt-8 rounded-[var(--radius-card)] bg-surface-card p-4 text-base text-text-secondary">
        <h3 className="font-semibold text-text-primary">About these checks</h3>
        <ul className="mt-2 space-y-1.5">
          <li>
            <strong className="text-text-primary">MongoDB Atlas</strong> —
            Database connectivity (weather cache, AI summaries, historical data)
          </li>
          <li>
            <strong className="text-text-primary">Tomorrow.io API</strong> —
            Primary weather data provider (realtime + forecast)
          </li>
          <li>
            <strong className="text-text-primary">Open-Meteo API</strong> —
            Fallback weather data provider (free, no auth)
          </li>
          <li>
            <strong className="text-text-primary">Shamwari AI</strong> — AI
            weather summaries (GLM on Workers AI, via Cloudflare AI Gateway)
          </li>
          <li>
            <strong className="text-text-primary">Weather Cache</strong> —
            Active cached weather data (15-min TTL)
          </li>
          <li>
            <strong className="text-text-primary">AI Summary Cache</strong> —
            Active cached AI summaries (30-120 min tiered TTL)
          </li>
        </ul>
        <p className="mt-3 text-text-tertiary">
          Status auto-refreshes every 5 minutes and is cached server-side for
          ~60 seconds. All checks run in parallel for minimum latency.
        </p>
      </div>
    </div>
  );
}
