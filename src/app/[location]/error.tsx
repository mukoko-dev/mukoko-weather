"use client";

import { RouteErrorBoundary, type RouteErrorProps } from "@/components/layout/RouteErrorBoundary";

export default function LocationError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Weather Unavailable"
      message="We couldn’t load weather data right now. This is usually a temporary issue with our weather providers."
      exhaustedMessage="This location’s weather data is temporarily unavailable. Try a different location or check back later."
      source="location"
      label="Weather page error"
      homeLabel="Go to Harare weather"
      extraLinks={[{ label: "View historical data instead", href: "/history" }]}
    />
  );
}
