"use client";

import { RouteErrorBoundary, type RouteErrorProps } from "@/components/layout/RouteErrorBoundary";

export default function GlobalError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Something went wrong"
      message="An unexpected error occurred. Please try again or return to the home page."
      exhaustedMessage="This page is experiencing persistent issues. Please try a different page or check back later."
      source="global"
      label="Application error"
    />
  );
}
