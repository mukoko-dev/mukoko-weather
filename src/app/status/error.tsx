"use client";

import {
  RouteErrorBoundary,
  type RouteErrorProps,
} from "@/components/layout/RouteErrorBoundary";

export default function StatusError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Status Unavailable"
      message="We couldn’t load the status page right now. Please try again."
      exhaustedMessage="The status page is temporarily unavailable. Please try again later."
      source="status"
      label="Status page error"
    />
  );
}
