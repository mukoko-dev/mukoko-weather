"use client";

import { RouteErrorBoundary, type RouteErrorProps } from "@/components/layout/RouteErrorBoundary";

export default function ExploreCountryError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Could not load countries"
      message="There was a problem loading the country list. This is usually a temporary issue."
      source="explore-country"
      label="Country explore error"
      retryTracking={false}
      homeHref="/explore"
      homeLabel="Back to Explore"
    />
  );
}
