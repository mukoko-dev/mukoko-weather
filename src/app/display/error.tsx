"use client";

import {
  RouteErrorBoundary,
  type RouteErrorProps,
} from "@/components/layout/RouteErrorBoundary";

export default function DisplayError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Display Unavailable"
      message="The weather display couldn’t load. It will try again."
      exhaustedMessage="The weather display is temporarily unavailable. Please check the connection and reload."
      source="display"
      label="Display page error"
    />
  );
}
