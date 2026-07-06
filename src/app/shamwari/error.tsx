"use client";

import { RouteErrorBoundary, type RouteErrorProps } from "@/components/layout/RouteErrorBoundary";

export default function ShamwariError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Chat Unavailable"
      message="We couldn’t load Shamwari Explorer right now. This may be a temporary issue."
      exhaustedMessage="Shamwari Explorer is temporarily unavailable. Please try again later."
      source="shamwari"
      label="Shamwari page error"
    />
  );
}
