"use client";

import { RouteErrorBoundary, type RouteErrorProps } from "@/components/layout/RouteErrorBoundary";

export default function ProvinceDetailError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Could not load province"
      message="There was a problem loading this province’s data. This is usually a temporary issue."
      source="explore-province-detail"
      label="Province detail error"
      retryTracking={false}
      homeHref="/explore/country"
      homeLabel="Browse all countries"
    />
  );
}
