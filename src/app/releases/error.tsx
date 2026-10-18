"use client";

import {
  RouteErrorBoundary,
  type RouteErrorProps,
} from "@/components/layout/RouteErrorBoundary";

export default function ReleasesError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Release Notes Unavailable"
      message="We couldn’t show the release notes right now. Please try again."
      exhaustedMessage="The release notes are temporarily unavailable. Please try again later."
      source="releases"
      label="Release notes page error"
    />
  );
}
