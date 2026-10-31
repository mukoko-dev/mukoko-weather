"use client";

import {
  RouteErrorBoundary,
  type RouteErrorProps,
} from "@/components/layout/RouteErrorBoundary";

export default function LocationsError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Locations Unavailable"
      message="We couldn’t load your locations right now. Please try again."
      exhaustedMessage="Your locations are temporarily unavailable. Please try again later."
      source="locations"
      label="Locations page error"
    />
  );
}
