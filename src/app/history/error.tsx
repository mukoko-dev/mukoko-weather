"use client";

import { RouteErrorBoundary, type RouteErrorProps } from "@/components/layout/RouteErrorBoundary";

export default function HistoryError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="History Unavailable"
      message="We couldn’t load historical weather data right now. This may be a temporary database issue."
      exhaustedMessage="Historical data is temporarily unavailable. Please try again later."
      source="history"
      label="History page error"
    />
  );
}
