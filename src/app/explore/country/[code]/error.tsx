"use client";

import { RouteErrorBoundary, type RouteErrorProps } from "@/components/layout/RouteErrorBoundary";

export default function CountryDetailError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Could not load country"
      message="There was a problem loading this country’s data. This is usually a temporary issue."
      source="explore-country-detail"
      label="Country detail error"
      retryTracking={false}
      homeHref="/explore/country"
      homeLabel="Browse all countries"
    />
  );
}
