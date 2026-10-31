"use client";

import {
  RouteErrorBoundary,
  type RouteErrorProps,
} from "@/components/layout/RouteErrorBoundary";

export default function ApiKeysError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="API Keys Unavailable"
      message="We couldn’t load your API keys right now. Please try again."
      exhaustedMessage="API keys are temporarily unavailable. Please try again later."
      source="api-keys"
      label="API keys page error"
    />
  );
}
