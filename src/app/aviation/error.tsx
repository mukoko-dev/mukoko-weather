"use client";

import { RouteErrorBoundary, type RouteErrorProps } from "@/components/layout/RouteErrorBoundary";

export default function AviationError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Briefing Unavailable"
      message="We couldn’t load the aviation weather briefing right now. This may be a temporary issue with METAR/TAF data."
      exhaustedMessage="The aviation weather briefing is temporarily unavailable. Please try again later."
      source="aviation"
      label="Aviation page error"
    />
  );
}
